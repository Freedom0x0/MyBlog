import type { ArticleDetail, ArticlePage, ArticleSummary } from 'shared'

/**
 * The server-side data layer, and the only module in this app that reads the portal
 * API from the server.
 *
 * Three rules this file exists to enforce:
 *
 * 1. **One door.** A component that needs articles calls a function here rather than
 *    writing its own `fetch`, so the base URL, the timeout, the cache policy and the
 *    failure semantics live in exactly one place.
 * 2. **An unreachable API is not an exception.** `next build` pre-renders `/`, and CI
 *    has postgres/redis/minio but *no api process* (design D-3). Every failure here
 *    therefore becomes `unavailable: true` plus a log line, and the page decides what
 *    to render. A thrown error would turn an infrastructure gap into a red build.
 * 3. **"Empty" is never a single state.** `articles: []` with `unavailable: false` is
 *    "this blog has no articles"; `unavailable: true` is "we could not ask". The SPA
 *    already had to learn that difference the hard way (S3: `HeroCarousel`'s `loading`
 *    prop), so the flag is part of the return type instead of being inferred from
 *    array length.
 *
 * Reads only. The write path stays in `apps/api`, and `/admin/*` stays on the SPA
 * (scope ruling P-2), so nothing in here sends a body.
 */

const API_INTERNAL_URL =
  (process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3001/api/v1').replace(/\/+$/, '')

/**
 * A hung API is worse than a dead one: without a timeout a request that never
 * answers holds the render open until whatever is in front of it gives up, and at
 * build time it holds the *build*. Refusing the connection (the CI case) is
 * instant; silence is not.
 */
const FETCH_TIMEOUT_MS = 5_000

/**
 * The staleness window, stated once (design D-4: 60 seconds, no on-demand
 * invalidation). Route modules assign `export const revalidate` from this value so
 * the number cannot drift between the page and its fetch.
 */
export const REVALIDATE_SECONDS = 60

/** A read that came back `unavailable` renders the same layout with a different label. */
export interface ArticleList {
  articles: ArticleSummary[]
  /**
   * `true` means the API could not be read (connection refused, timeout, 5xx,
   * a body that did not match the contract). It is never a statement about
   * whether the blog has articles.
   */
  unavailable: boolean
}

export interface ArticleLookup {
  /** `null` with `unavailable: false` is a genuine "no such published article". */
  article: ArticleDetail | null
  unavailable: boolean
}

/**
 * `GET` a JSON body, with every failure mode turned into a value instead of a throw.
 *
 * `null` means "did not get a usable answer"; the caller names which kind of answer
 * it wanted and sets `unavailable`. A `notFound` result is separated out because the
 * detail page must render *its* not-found state (and 404 status) for a bad slug, not
 * the degraded one — those are different claims about the world.
 */
/**
 * The three answers a read can produce, named so callers can annotate.
 *
 * `fetchAllPublished` needs this annotation: inside a loop, narrowing `cursor` from
 * a value assigned out of the previous iteration's response makes TypeScript's
 * control-flow analysis circle back through `result` → `query` → `cursor`, which it
 * reports as TS7022 rather than resolving. Naming the outcome type breaks the cycle
 * at the cost of one alias.
 */
type JsonOutcome<T> = { kind: 'ok'; value: T } | { kind: 'not-found' } | { kind: 'unavailable' }

async function getJSON<T>(
  path: string,
  label: string,
): Promise<JsonOutcome<T>> {
  let response: Response

  try {
    response = await fetch(`${API_INTERNAL_URL}${path}`, {
      headers: { accept: 'application/json' },
      cache: 'default',
      next: { revalidate: REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    logUnavailable(label, error)
    return { kind: 'unavailable' }
  }

  if (response.status === 404) return { kind: 'not-found' }

  if (!response.ok) {
    logUnavailable(label, `HTTP ${response.status}`)
    return { kind: 'unavailable' }
  }

  try {
    return { kind: 'ok', value: (await response.json()) as T }
  } catch (error) {
    logUnavailable(label, error)
    return { kind: 'unavailable' }
  }
}

/**
 * One warning per degraded read, on the same words the page will show.
 *
 * It goes to the log rather than only to the HTML because the case this exists for —
 * a build with no API, or an ISR regeneration that silently fails — happens where no
 * person is watching a browser console.
 */
function logUnavailable(label: string, cause: unknown): void {
  const reason = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
  console.warn(
    `[web-next] ${label} is unavailable (${reason}). ` +
      'Rendering the degraded empty state; see design D-3 — an unreachable API is not a build error.',
  )
}

/**
 * The public list: published articles only, newest first (`GET /articles`).
 *
 * `next` (the cursor envelope field) is ignored on purpose: neither public page has a
 * pagination control yet, and the homepage renders one page of cards. The envelope
 * type is kept in scope so the day a "load more" exists, the field is already typed.
 */
export async function fetchArticleList(limit: number): Promise<ArticleList> {
  const result = await getJSON<ArticlePage>(`/articles?limit=${limit}`, 'article list')

  if (result.kind === 'unavailable') return { articles: [], unavailable: true }
  // A 404 on the collection endpoint would be a routing fault, not an empty blog.
  if (result.kind === 'not-found') return { articles: [], unavailable: true }

  return { articles: result.value.data, unavailable: false }
}

/**
 * Every published article, by walking the keyset cursor to the end.
 *
 * This exists because `limit` is capped at 50 server-side
 * (`ListQuerySchema` in `apps/api/src/modules/articles/schema.ts:25`), and a
 * sitemap or RSS feed built from a single page would therefore **silently drop
 * article 51 onward** — the worst kind of truncation, since it looks correct on a
 * small blog and is discovered only after the blog has grown.
 *
 * `MAX_PAGES` bounds the loop rather than trusting the cursor to terminate: a
 * contract break upstream (a `next` that repeats itself) must not turn a page
 * generator into an unbounded fetch loop. 20 pages is 1 000 articles at the
 * current cap, which is far past what a personal blog reaches; if that ever stops
 * being true, raise the bound here rather than removing it.
 */
const MAX_PAGES = 20

/** The server's own per-page ceiling (`ListQuerySchema`), so one page carries the most it can. */
const LIST_PAGE_LIMIT_MAX = 50

export async function fetchAllPublished(): Promise<ArticleList> {
  const articles: ArticleSummary[] = []
  let cursor: string | null = null

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query: string =
      cursor === null
        ? `limit=${LIST_PAGE_LIMIT_MAX}`
        : `limit=${LIST_PAGE_LIMIT_MAX}&cursor=${encodeURIComponent(cursor)}`

    const result: JsonOutcome<ArticlePage> = await getJSON<ArticlePage>(
      `/articles?${query}`,
      'article list (feed)',
    )

    // A failure on a later page is not a licence to publish a half feed as if it
    // were the whole one: report degraded, and let the callers emit the state that
    // says so.
    if (result.kind !== 'ok') return { articles: [], unavailable: true }

    articles.push(...result.value.data)

    const nextPage = result.value.next
    if (nextPage === null) return { articles, unavailable: false }
    cursor = nextPage.cursor
  }

  // MAX_PAGES × 50 = 1 000 published articles. Past that we ship what we have and
  // shout, rather than returning nothing (worse for readers) or staying silent
  // (worse for whoever has to debug this at 3am).
  console.warn(
    `[web-next] fetchAllPublished stopped at ${MAX_PAGES} pages — raise MAX_PAGES in lib/api.ts; the feed is truncated`,
  )
  return { articles, unavailable: false }
}

/**
 * One published article with its markdown body (`GET /articles/:slug`), or nothing.
 *
 * The API answers 404 for both "no such slug" and "that slug is a draft", and this
 * layer preserves that: a draft must not be distinguishable from a typo to an
 * anonymous reader. `encodeURIComponent` matters for a slug that ever contains a
 * percent or an asterisk.
 */
export async function fetchArticle(slug: string): Promise<ArticleLookup> {
  const result = await getJSON<ArticleDetail>(
    `/articles/${encodeURIComponent(slug)}`,
    `article "${slug}"`,
  )

  if (result.kind === 'unavailable') return { article: null, unavailable: true }
  if (result.kind === 'not-found') return { article: null, unavailable: false }

  return { article: result.value, unavailable: false }
}
