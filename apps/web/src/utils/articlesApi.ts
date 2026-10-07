import { apiGet, apiDelete, apiPatch, apiPost, ApiError } from '../lib/apiClient'
import type {
  AdminArticlePage,
  ArticleAdmin,
  ArticleDetail,
  ArticlePage,
  ArticleStatus,
  ArticleSummary,
  CreateArticleInput,
  ExportedBlog,
  ImportArticleFile,
  ImportArticlesResponse,
  UpdateArticleInput,
} from 'shared'

/**
 * Article reads and writes, all of them against the portal API.
 *
 * The write path used to be the last thing pointing at a third-party store, which
 * is why this file once carried a snake_case record shape alongside the camelCase
 * DTOs. That shape is gone: the API speaks one wire format end to end, so there is
 * now one article shape per view and no client-side translation of column names.
 */

const LIST_LIMIT = 50

/**
 * The public list: published articles only, newest first.
 *
 * Returns the page's rows rather than the envelope because the only caller today
 * renders one page and has no pagination control. `next` is dropped here, not
 * lost — `listAdminArticles` keeps the envelope for the caller that will page.
 */
export async function listArticles(): Promise<ArticleSummary[]> {
  const page = await apiGet<ArticlePage>(`/articles?limit=${LIST_LIMIT}`)
  return page.data
}

/**
 * `null` means "no published article with that slug".
 *
 * The API answers 404 for missing *and* unpublished on purpose, so this cannot
 * tell a draft apart from a typo — which is correct for a public client. A client
 * that is allowed to see drafts uses {@link getAdminArticle} instead; mapping 404
 * to `null` there would turn "you have a draft" into "you have nothing".
 */
export async function getArticleBySlug(slug: string): Promise<ArticleDetail | null> {
  try {
    return await apiGet<ArticleDetail>(`/articles/${encodeURIComponent(slug)}`)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

/**
 * `GET /api/v1/admin/articles` — every status, newest change first, no bodies.
 * Kept separate from {@link listArticles} because the two endpoints differ in
 * `data`'s type, not just in size; see `AdminArticlePage` in `shared`.
 */
export async function listAdminArticles(options: {
  limit?: number
  cursor?: string
  status?: ArticleStatus
} = {}): Promise<AdminArticlePage> {
  const params = new URLSearchParams()
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.cursor !== undefined) params.set('cursor', options.cursor)
  if (options.status !== undefined) params.set('status', options.status)

  const query = params.toString()
  return apiGet<AdminArticlePage>(`/admin/articles${query ? `?${query}` : ''}`)
}

/**
 * `GET /api/v1/admin/articles/:slug` — full body plus `status`.
 *
 * Deliberately *not* swallowed into `null` on 404 the way the public read is. An
 * admin asking for a draft they can see in the list and getting a blank form back
 * was the original bug; a 404 here is an error to show, not a state to render.
 */
export async function getAdminArticle(slug: string): Promise<ArticleAdmin> {
  return apiGet<ArticleAdmin>(`/admin/articles/${encodeURIComponent(slug)}`)
}

/**
 * `POST /api/v1/articles` → 201 with the new article.
 *
 * No `status` is sent, and `CreateArticleInput` has no such field: creation
 * landing on `draft` is the server's structural guarantee (design §1.1), so the
 * client must not "help" by naming one.
 */
export async function createArticle(input: CreateArticleInput): Promise<ArticleAdmin> {
  return apiPost<ArticleAdmin>('/articles', input)
}

/**
 * `PATCH /api/v1/articles/:slug` → 200.
 *
 * Carries only what the caller changed. `status` belongs to this call and nowhere
 * else — publishing or un-publishing is a patch that names `status`, everything
 * else is a patch that does not.
 */
export async function updateArticle(slug: string, input: UpdateArticleInput): Promise<ArticleAdmin> {
  return apiPatch<ArticleAdmin>(`/articles/${encodeURIComponent(slug)}`, input)
}

/** `DELETE /api/v1/articles/:slug` → 204. */
export async function deleteArticle(slug: string): Promise<void> {
  return apiDelete(`/articles/${encodeURIComponent(slug)}`)
}

/**
 * `POST /api/v1/articles/import` → 200 with one result per file.
 *
 * The *raw* markdown text is what travels. Parsing lives on the server so that
 * there is exactly one parser and exactly one write path (design §3): a client
 * that parsed front-matter itself would be a second validator that a hand-edited
 * request body walks around.
 *
 * Overwriting a collision therefore does not need a browser-side parser either:
 * a `conflict` result carries `proposed`, the structured draft the server had
 * already built and chose not to write (design §3.3). Handing that to
 * `updateArticle(slug, proposed)` is the whole overwrite path — one parse, one
 * write door, and the decision made per row by a person who can see the filename.
 *
 * A 200 can contain `kind: 'conflict'` rows *and* already-written drafts (design
 * §6): the batch was accepted, so the status says nothing about individual files.
 * Callers must render `results`, not treat 200 as "everything became an article".
 */
export async function importArticles(
  files: ImportArticleFile[],
): Promise<ImportArticlesResponse> {
  return apiPost<ImportArticlesResponse>('/articles/import', { files })
}

/**
 * ── The way out (S8-a) ────────────────────────────────────────────────────────
 *
 * `GET /api/v1/admin/articles/export` as a saved file.
 *
 * **fetch+blob through {@link apiGet}, not an `<a href>` to the API** — and the four
 * reasons are all properties of this app, not taste:
 *
 * 1. `apiClient.ts` is the only module in `apps/web` that calls `fetch`, and it is the
 *    only one that attaches the session. A hand-written link would be a second
 *    transport with its own — smaller — set of guarantees, and the header comment there
 *    is explicit that the next exception has to be argued for, not assumed.
 * 2. The download has to survive the failure cases. A `<a href>` that gets a 401 or a
 *    403 *navigates the admin page to the JSON error envelope*: the list disappears and
 *    the person reads `{"error":{"code":"UNAUTHORIZED",…}}` in the address bar instead
 *    of the 中文 message every other screen in this app shows through
 *    {@link describeApiError}.
 * 3. In development the API is a **different origin** (`VITE_API_BASE_URL` defaults to
 *    `http://localhost:3001` while the SPA runs on 5175). The `download` attribute is
 *    ignored cross-origin, so a link would navigate or open a tab rather than save —
 *    exactly the case where the button is used most.
 * 4. Session, not cookie: the API's `requireAuth` accepts the bearer only from an
 *    `Authorization` header or the `portal_access` cookie. Whether the cookie is even
 *    attached to a top-level cross-site navigation depends on `COOKIE_SECURE` and
 *    SameSite, so a link's success would depend on the deployment shape. `apiGet` sends
 *    `credentials: 'include'`, which works in both.
 *
 * What that buys, and its price: the whole document is held three times — the parsed
 * object, the re-serialised string, the Blob — instead of streaming to disk. At the size
 * this endpoint returns today (125,159 bytes on the wire for the whole seeded blog,
 * measured) that is nothing, and it is the same buffering trade the server documents in
 * `exportAll`. If the blog ever grows past a few hundred articles, the fix is on both
 * sides at once (a streamed response and no client-side re-parse), not a
 * `window.location` assignment.
 *
 * `exportedAt` is the filename's only input, which is why it cannot be an article's
 * slug or title: a download name assembled from stored user text is the same class of
 * mistake as an object key assembled from an uploaded file's name.
 */
export async function downloadBlogExport(): Promise<{ files: number; bytes: number }> {
  const doc = await apiGet<ExportedBlog>('/admin/articles/export')

  const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)

  /**
   * A detached anchor rather than `window.open`: a navigation would replace the list
   * this button sits on, and the person is about to import those files back into it.
   * Appended first because Firefox does not fire `click()` on a detached element.
   */
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = exportFilename(doc.exportedAt)
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // Released on the next turn rather than immediately: the download is queued by the
  // click, and revoking the object URL in the same tick can beat it.
  setTimeout(() => URL.revokeObjectURL(url), 0)

  return { files: doc.articles.length, bytes: blob.size }
}

/**
 * `myblog-export-2026-10-08.json`, from the server's own `exportedAt`.
 *
 * The UTC calendar day, which is the same rule `buildExportFilename` uses in the API —
 * so the name the browser saves matches the `Content-Disposition` the very same response
 * carries, and a backup pulled with `curl` and one pulled from this button differ in
 * nothing that matters. It is a *copy* of that rule rather than a read of the header,
 * because {@link apiGet} returns the parsed body and headers are not the business of this
 * layer; if the server's naming ever changes, this file's name changes with it and the
 * header remains authoritative for every other client.
 */
function exportFilename(exportedAt: string): string {
  return `myblog-export-${new Date(exportedAt).toISOString().slice(0, 10)}.json`
}
