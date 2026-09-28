import type { Pool } from 'pg'
import type { CommentNode } from 'shared'

/**
 * Comment data access.
 *
 * The author is joined from `users` rather than copied onto the comment. The old
 * table stored `user_name` and `avatar_url` as snapshots taken at insert time, so
 * a person who renamed themselves on GitHub kept a stale name on every comment
 * they had ever written, with no way to fix it. Storing only the key and joining
 * is what makes that update itself.
 *
 * The `join` (not left join) is consistent with the schema: `user_id` is
 * `not null references users on delete cascade`, so a comment outliving its user
 * cannot exist.
 */
export class CommentRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Chronological, flat.
   *
   * Ascending here even though the index is declared descending — Postgres scans
   * a btree backwards at the same cost, and threads read oldest-first.
   *
   * No server-side tree building: nesting is shallow, and returning the rows flat
   * with a `parentId` keeps this to one indexed query. The client assembles.
   */
  async listForArticle(articleId: string): Promise<CommentNode[]> {
    const result = await this.pool.query<CommentRow>(
      `select c.id, c.article_id, c.parent_id, c.content, c.created_at,
              u.id as author_id, u.github_login, u.display_name, u.avatar_url
         from comments c
         join users u on u.id = c.user_id
         where c.article_id = $1
         order by c.created_at asc, c.id asc`,
      [articleId],
    )

    return result.rows.map((row) => ({
      id: row.id,
      articleId: row.article_id,
      parentId: row.parent_id,
      content: row.content,
      author: {
        id: row.author_id,
        login: row.github_login,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
      },
      createdAt: row.created_at.toISOString(),
    }))
  }
}

interface CommentRow {
  id: string
  article_id: string
  parent_id: string | null
  content: string
  created_at: Date
  author_id: string
  github_login: string
  display_name: string | null
  avatar_url: string | null
}
