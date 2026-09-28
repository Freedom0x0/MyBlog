import { apiGet } from '../lib/apiClient'
import type { CommentList, CommentNode } from 'shared'

/**
 * Comment reads go through the portal API.
 *
 * Writing stays on Supabase until S3, which is why this file is read-only. The
 * read matters on its own: the API joins the author from `users`, so a comment
 * shows the name its author has *now* rather than the one they had when they
 * posted it — the old snapshot columns could not do that.
 */
export async function listComments(slug: string): Promise<CommentNode[]> {
  const list = await apiGet<CommentList>(
    `/articles/${encodeURIComponent(slug)}/comments`,
  )
  return list.data
}
