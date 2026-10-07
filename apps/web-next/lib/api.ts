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
async function getJSON<T>(
  path: string,
  label: string,
): Promise<{ kind: 'ok'; value: T } | { kind: 'not-found' } | { kind: 'unavailable' }> {
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
