import { expect, test } from '@playwright/test'
import {
  firstSectionHeading,
  headingPattern,
  htmlText,
  markupOnly,
  OG_TITLE_PATTERN,
  publishedArticle,
  publishedArticles,
  staleCacheHint,
  waitForServerRenderedHome,
} from './server-html'

/**
 * S4-e acceptance, three tests, one sentence each:
 *
 * 1. `/` puts an article title in the HTML the server writes.
 * 2. `/blog/[slug]` puts the article's own section heading in that HTML, and identifies
 *    itself with the article's title in `<meta property="og:title">`.
 * 3. `/sitemap.xml` is a parseable sitemap with one `<loc>` per published article plus
 *    the homepage, and no draft in it.
 *
 * Every assertion here is made against `await response.text()` from the `request`
 * fixture. No `page`, no `context`, no browser: the moment a JavaScript engine is in the
 * loop, a page that renders itself in the visitor's browser passes, and that is the
 * precise regression this stage exists to catch (the SPA's HTML carried one site-level
 * `<title>` and no article content at all). See `server-html.ts` for the second half of
 * that argument — why `<script>` elements are stripped before asserting.
 */

/** The seeded published article whose body carries a `## ` heading. */
const ARTICLE_SLUG = 'normal-published'

/**
 * The seeded draft (`apps/api` seed: 7 articles, 6 published).
 *
 * Its existence cannot be confirmed through a public endpoint — a draft and a typo both
 * answer 404, by design — so if the seed ever drops this row the negative assertion below
 * becomes vacuous. The fixture itself is guarded by `apps/api`'s own suites, which read
 * the database.
 */
const DRAFT_SLUG = 'draft-unpublished'

test.describe('public pages serve their content in the server HTML', () => {
  test('the homepage writes article titles into the HTML the server sends', async ({ request }) => {
    // `/` may need to wait out the build-time ISR cache; see `waitForServerRenderedHome`.
    test.setTimeout(180_000)

    const published = await publishedArticles(request)
    expect(
      published.length,
      'the oracle found no published article to look for — the seed baseline is 7 articles / 6 published',
    ).toBeGreaterThan(0)

    const titles = published.map((article) => htmlText(article.title))
    const markup = await waitForServerRenderedHome(request, titles)

    for (const title of titles) {
      expect(
        markup,
        `"${title}" is not in the markup of \`GET /\` (script elements removed)` +
          staleCacheHint(markup),
      ).toContain(title)
    }
  })

  test('an article page server-renders its own section heading and its own og:title', async ({
    request,
  }) => {
    const article = await publishedArticle(request, ARTICLE_SLUG)
    const heading = htmlText(firstSectionHeading(article.content))

    const response = await request.get(`/blog/${ARTICLE_SLUG}`)
    expect(response.status(), '`GET /blog/[slug]` did not answer 200').toBe(200)

    const body = await response.text()
    const markup = markupOnly(body)

    // The heading must be an `<h2>` in the markup. The article's own markdown says `## 小节`,
    // so anything else — a paragraph, an attribute, the flight payload — is not "the section
    // heading was rendered on the server".
    expect(
      markup,
      `the article's own heading "${heading}" is not an <h2> in the markup of the response`,
    ).toMatch(headingPattern(heading))

    const ogTitle = OG_TITLE_PATTERN.exec(markup)
    if (ogTitle === null) {
      // Thrown rather than asserted so the two failure shapes cannot be confused: "no
      // og:title tag at all" is not the same fault as "the wrong og:title", and the
      // message below is the one worth reading.
      throw new Error(
        'the response markup carries no `<meta property="og:title">` at all — per-article metadata never reached the document head',
      )
    }

    expect(
      ogTitle[1],
      'og:title must carry this article\'s title; the site default is what a link-preview bot would then repeat for every article',
    ).toBe(htmlText(article.title))
  })

  test('the sitemap has one <loc> per published article plus the homepage, and no draft', async ({
    request,
  }) => {
    const published = await publishedArticles(request)

    const response = await request.get('/sitemap.xml')
    expect(response.status(), '`GET /sitemap.xml` did not answer 200').toBe(200)

    const xml = await response.text()

    // The negative half first, over the whole document rather than only the `<loc>`
    // values: a draft appearing anywhere in it — an entry, a comment, a `lastmod` — is a
    // draft being advertised to every crawler that fetches this file.
    expect(
      xml,
      'the draft slug appears in the sitemap: unpublished content is being advertised to crawlers',
    ).not.toContain(DRAFT_SLUG)

    const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])

    // Every `<loc>` must be an absolute URL with a host — `new URL()` is that check, and
    // it throws on a relative one.
    const paths = locations.map((location) => new URL(location).pathname)

    expect(
      paths,
      `the sitemap should carry one entry per published article (${published.length}) plus the homepage`,
    ).toHaveLength(published.length + 1)
    expect(paths, 'the homepage should be in the sitemap').toContain('/')

    // `articlePath()` percent-encodes each slug, so the comparison is made on the
    // encoded form. Sorted, and through a `Set`, so a duplicated `<loc>` cannot hide a
    // missing one — the count above would still catch it, but this message names the URL.
    const expectedPaths = [
      ...new Set(['/', ...published.map((article) => `/blog/${encodeURIComponent(article.slug)}`)]),
    ].sort()

    expect(
      [...new Set(paths)].sort(),
      'the sitemap URLs and the published set read from the API are not the same set',
    ).toEqual(expectedPaths)
  })
})
