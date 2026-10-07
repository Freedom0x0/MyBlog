import { REVALIDATE_SECONDS, fetchAllPublished } from '../../lib/api'
import { articlePath, publicOrigin } from '../../lib/site'

/**
 * `GET /rss.xml` — RSS 2.0, published articles only, newest first.
 *
 * Hand-built rather than pulled in as a dependency (`feed`, `rss`) for the reason
 * that decided stage C overall: a feed generator earns its place when the item shape
 * gets complicated, and this one is five fields per item. A dependency would also
 * own the date and escaping formats, which are exactly the two things a validator
 * complains about and a reader cannot see.
 *
 * `force-dynamic` (design D-3): a prerendered feed at build time — when the API is
 * deliberately unreachable in CI — would ship as an empty `<channel>` forever, and
 * an empty feed is worse than a 500 because every aggregator accepts it happily.
 *
 * `description` carries the excerpt, not the article body: the body is markdown and
 * would need to be rendered twice (once for the page, once for a feed reader that
 * expects HTML), which is a content decision about how much of a post belongs in a
 * syndicated copy — not something to decide as a side effect of wiring a route.
 */
export const dynamic = 'force-dynamic'
// No `export const revalidate` alongside it — the two are a contradictory segment
// configuration and Next 16 fails the build over it. The 60s window (design D-4) is
// still honoured, just where a route handler can express it: the `cache-control`
// header below, which is what nginx or a CDN in front of this app will act on.

const SITE_TITLE = 'Guoshaoran Blog'
const SITE_DESCRIPTION = 'Guoshaoran 的个人博客：技术文章、开源项目与实践笔记。'

/**
 * The five XML reserved characters.
 *
 * Ampersand first and unconditionally: titles here contain Chinese text and
 * occasional `&` in English names, and an unescaped `&` is the single most common
 * reason a feed fails to parse. Order matters — escaping `&` last would double-escape
 * the entities produced for the others.
 */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** RFC 822 date, which is what RSS 2.0 validators require for pubDate. */
function rfc822(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? new Date().toUTCString() : date.toUTCString()
}

export async function GET(): Promise<Response> {
  const origin = publicOrigin()
  const { articles, unavailable } = await fetchAllPublished()

  const items = articles
    .map(
      (article) => `    <item>
      <title>${xmlEscape(article.title)}</title>
      <link>${xmlEscape(`${origin}${articlePath(article.slug)}`)}</link>
      <guid isPermaLink="true">${xmlEscape(`${origin}${articlePath(article.slug)}`)}</guid>
      <pubDate>${rfc822(article.publishedAt)}</pubDate>
      <description>${xmlEscape(article.excerpt)}</description>
    </item>`,
    )
    .join('\n')

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${xmlEscape(SITE_TITLE)}</title>
    <link>${xmlEscape(`${origin}/`)}</link>
    <description>${xmlEscape(
      unavailable ? `${SITE_DESCRIPTION} (feed temporarily unavailable — the article API could not be read)` : SITE_DESCRIPTION,
    )}</description>
${items}
  </channel>
</rss>
`

  if (unavailable) {
    console.warn('[web-next] rss.xml served without items: the API was unreachable')
  }

  return new Response(body, {
    headers: {
      'content-type': 'application/rss+xml; charset=utf-8',
      // The route's own `revalidate` governs the ISR cache; this header is for
      // whatever sits in front, and 60s matches so the two cannot disagree.
      'cache-control': `public, max-age=0, s-maxage=${REVALIDATE_SECONDS}, stale-while-revalidate=${REVALIDATE_SECONDS}`,
    },
  })
}
