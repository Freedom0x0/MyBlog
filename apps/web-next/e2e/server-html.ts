import { expect, type APIRequestContext } from '@playwright/test'
import type { ArticleDetail, ArticlePage, ArticleSummary } from 'shared'

/**
 * The two things these end-to-end tests need and `lib/` deliberately does not offer:
 * an independent oracle, and a way to say "in the markup" rather than "in the bytes".
 *
 * Both exist for one reason. The claim under test is that a page's content is in the
 * HTML **the server writes** — the only thing a crawler or a link-preview bot reads.
 * Two things can fake that claim, and this file is written to defeat both:
 *
 * 1. **`page.content()` after load.** Once the browser has hydrated, a
 *    client-rendered page's markup is identical to a server-rendered one's. Anything
 *    asserted over it proves nothing about the server. So the tests assert over
 *    `request.get()` bodies only — no browser, no JavaScript engine, the response as
 *    sent — and never over `page`/`context`.
 * 2. **Next's flight payload.** A server component serializes its props into the
 *    document as `<script>self.__next_f.push([1,"…"])</script>`, so an article's title
 *    and body appear as *text* in the raw response even when the visible markup has
 *    none of it — which is exactly what a page that renders in the browser looks like
 *    on the wire. `markupOnly()` drops `<script>` elements, so "it is in the response"
 *    means "it is in the markup a crawler reads", not "it is somewhere in the payload".
 *
 * The oracle is the portal API at `http://127.0.0.1:3001`, asked directly. Not through
 * `apps/web-next`'s own `/api/v1/:path*` rewrite: if the page and the check read their
 * facts through the same door, a broken door cannot make the check fail.
 *
 * The port is written here a second time on purpose (`playwright.config.ts` has the
 * same pair); it is a loopback port, not a credential, and importing the config into a
 * test file is not something Playwright promises to keep working.
 */

const API_ORIGIN = 'http://127.0.0.1:3001'

/**
 * The article list endpoint's own page ceiling (`ListQuerySchema` in
 * `apps/api/src/modules/articles/schema.ts`), so the oracle reads the whole published
 * set rather than the first 50 articles and calling that "everything".
 *
 * This walks the keyset cursor independently of `lib/api.ts`'s `fetchAllPublished`:
 * agreement between two implementations is the point of an oracle, and if both truncate
 * at 50 the sitemap test would grade the app against the same mistake.
 */
const ORACLE_PAGE_LIMIT = 50
const ORACLE_MAX_PAGES = 40

/** The published set, straight from the API — the source of truth the pages are graded against. */
export async function publishedArticles(request: APIRequestContext): Promise<ArticleSummary[]> {
  const articles: ArticleSummary[] = []
  let cursor: string | null = null

  for (let page = 0; page < ORACLE_MAX_PAGES; page += 1) {
    const query =
      cursor === null
        ? `limit=${ORACLE_PAGE_LIMIT}`
        : `limit=${ORACLE_PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`

    const response = await request.get(`${API_ORIGIN}/api/v1/articles?${query}`)
    expect(
      response.status(),
      `the oracle could not read the published list (HTTP ${response.status()}) — is the portal API on ${API_ORIGIN}?`,
    ).toBe(200)

    const body = (await response.json()) as ArticlePage
    articles.push(...body.data)

    if (body.next === null) return articles
    cursor = body.next.cursor
  }

  throw new Error(
    `[e2e oracle] the published list did not end within ${ORACLE_MAX_PAGES} pages of ${ORACLE_PAGE_LIMIT}`,
  )
}

/** One published article with its markdown body, from the same oracle. */
export async function publishedArticle(
  request: APIRequestContext,
  slug: string,
): Promise<ArticleDetail> {
  const response = await request.get(`${API_ORIGIN}/api/v1/articles/${encodeURIComponent(slug)}`)
  expect(
    response.status(),
    `the oracle could not read article "${slug}" (HTTP ${response.status()}) — the seed fixture is missing or is no longer published`,
  ).toBe(200)

  return (await response.json()) as ArticleDetail
}

/**
 * The document minus every `<script>` element: what a crawler that does not run
 * JavaScript is left holding.
 *
 * Non-greedy `[\s\S]*?` up to the first `</script>`, which is how HTML itself closes a
 * script element — a `</script>` inside a string literal would end the element in a
 * browser too, so this matches the browser's reading rather than inventing a stricter one.
 */
export function markupOnly(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
}

/**
 * Turns a value read from the API into the needle that finds it in HTML: React escapes
 * `&`, `<`, `>` and `"` when it writes text and attribute values.
 *
 * Every needle these tests look for is *article content* — a title, a heading — chosen by
 * whoever wrote the article, so a future title carrying an `&` would be searched for
 * unescaped, miss, and read as a rendering regression. `&` is replaced first, or the
 * later passes would rewrite the entities this one just produced.
 */
export function htmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The article's own first level-2 markdown heading, taken from the API's body rather
 * than hardcoded, so the test says "the article's section heading" instead of "小节".
 */
export function firstSectionHeading(markdown: string): string {
  const match = /^##[ \t]+(.+?)[ \t]*$/m.exec(markdown)
  if (match === null) {
    throw new Error(
      '[e2e] the article the detail test reads has no `## ` heading, so the "section heading is server-rendered" ' +
        'assertion would have nothing to look for. Add a `## ` heading to that fixture (apps/api seed) — do not ' +
        'relax this helper to pass.',
    )
  }

  return match[1]
}

/** Escapes a string for use inside a `RegExp` built at runtime. */
function toPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * `<h2>…</h2>` carrying that heading text, attribute-order independent.
 *
 * The tag is checked, not just the words: the words alone would also be satisfied by the
 * heading appearing in an excerpt or a paragraph, which is not the claim
 * ("the section heading is in the server HTML"). Takes the value already through
 * `htmlText`, because the thing being matched lives in HTML.
 */
export function headingPattern(escapedHeading: string): RegExp {
  return new RegExp(`<h2\\b[^>]*>\\s*${toPattern(escapedHeading)}\\s*</h2>`, 'i')
}

/**
 * `<meta property="og:title" content="…">`, whether Next emitted the tag self-closed
 * or not. Group 1 is the value the document's `<head>` really carries.
 */
export const OG_TITLE_PATTERN = /<meta\s+property="og:title"\s+content="([^"]*)"\s*\/?>/i

/**
 * The homepage's own words for "the article list could not be read", from `app/page.tsx`
 * and `components/hero-carousel.tsx`. Used only to make a failure self-explaining.
 */
const DEGRADED_MARKER = '接口不可达'

/**
 * Fetch `/` until its markup carries the published titles, and return the last response.
 *
 * Why a harness has to do this at all: `/` is a static route with `revalidate = 60`, so
 * `next build` prerenders it — and in CI (and on any machine following this repo's own
 * instructions) the build runs while the API is *not* listening, because design D-3 says
 * an unreachable API must not break the build. The artifact that leaves `next build` is
 * therefore the degraded page, and `next start` serves that cached page until 60 seconds
 * have passed *and* a request has arrived to trigger regeneration. The e2e step follows
 * the Build step by seconds, so the first fetch of `/` is the stale build output rather
 * than what this server can render.
 *
 * It is a wait, not a weakening: the warm-up gives up and hands the last body back to the
 * assertions, so a page that genuinely does not render articles in its markup still goes
 * red — it just goes red with a message that says which of the two happened.
 */
export async function waitForServerRenderedHome(
  request: APIRequestContext,
  titleNeedles: string[],
): Promise<string> {
  const deadlineMs = 100_000
  const pollMs = 2_000
  const startedAt = Date.now()

  for (;;) {
    const response = await request.get('/')
    expect(response.status(), '`GET /` did not answer 200').toBe(200)

    const markup = markupOnly(await response.text())
    if (titleNeedles.every((needle) => markup.includes(needle))) return markup
    if (Date.now() - startedAt > deadlineMs) return markup

    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/** The sentence to append when a warm-up gave up on the build-time degraded page. */
export function staleCacheHint(markup: string): string {
  return markup.includes(DEGRADED_MARKER)
    ? ' — this response is the build-time degraded page (design D-3: `next build` ran with no API reachable) and the ISR cache had not regenerated within the warm-up window'
    : ''
}
