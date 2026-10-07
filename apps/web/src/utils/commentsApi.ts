import { apiDelete, apiGet, apiPost } from '../lib/apiClient'
import type { CommentList, CommentNode, CreateCommentInput } from 'shared'

/**
 * Comments, all through the portal API.
 *
 * This file used to be read-only because inserts went to the previous store, whose
 * row-level policy needed an id that third party issued. The API derives the author
 * from the verified session token instead — `CreateCommentInput` has no author
 * field for exactly that reason — so the write and the read now agree on who owns a
 * comment.
 *
 * The read matters on its own: the API joins the author from `users`, so a
 * comment shows the name its author has *now* rather than the one they had when
 * they posted it — the old snapshot columns could not do that.
 */
export async function listComments(slug: string): Promise<CommentNode[]> {
  const list = await apiGet<CommentList>(
    `/articles/${encodeURIComponent(slug)}/comments`,
  )
  return list.data
}

/**
 * `POST /api/v1/articles/:slug/comments` → 201 with the full `CommentNode`.
 *
 * The response is the server's answer (joined author, its own id and timestamp),
 * so a caller appends it to the thread instead of reconstructing a node from its
 * own token — the two would otherwise be free to drift.
 *
 * `parentId`, when set, must point at a comment on the *same* article: the API
 * answers 400 `INVALID_COMMENT_PARENT` otherwise, and this client passes it
 * through untouched rather than trying to repair it first.
 */
export async function postComment(slug: string, input: CreateCommentInput): Promise<CommentNode> {
  return apiPost<CommentNode>(`/articles/${encodeURIComponent(slug)}/comments`, input)
}

/**
 * `DELETE /api/v1/comments/:id` → 204.
 *
 * Author or administrator, enforced server-side (403 for anyone else). The 403
 * here and the draft article's 404 are deliberately different answers — see
 * design §2 — so a caller that wants to explain the failure branches on
 * `ApiError.code`, not on this function's return.
 */
export async function deleteComment(id: string): Promise<void> {
  return apiDelete(`/comments/${encodeURIComponent(id)}`)
}
