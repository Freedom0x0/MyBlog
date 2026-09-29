import { apiGet, apiDelete, apiPatch, apiPost, ApiError } from '../lib/apiClient'
import type {
  AdminArticlePage,
  ArticleAdmin,
  ArticleDetail,
  ArticlePage,
  ArticleStatus,
  ArticleSummary,
  CreateArticleInput,
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
