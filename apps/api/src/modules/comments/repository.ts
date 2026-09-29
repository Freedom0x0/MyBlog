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

/**
 * One projection shared by the list query, the single fetch and the insert, so the
 * three cannot disagree about what a comment looks like.
 *
 * `author_id` comes from the comment's own `user_id` foreign key rather than from
 * the joined `u.id`. The join condition makes the two identical, but naming the
 * stored key says *why* the field exists: the delete path compares it against the
 * requester, and that comparison has to be about the row being deleted, not about
 * whichever user row happened to match it.
 *
 * The alias is a parameter because the insert reads its new row from its own
 * data-modifying CTE (`i`), not from `comments` (`c`) — see `insert`.
 */
const commentColumns = (from: 'c' | 'i'): string =>
  `${from}.id, ${from}.article_id, ${from}.parent_id, ${from}.content, ${from}.created_at,
         ${from}.user_id as author_id, u.github_login, u.display_name, u.avatar_url`

/** Fully-resolved values for a new comment; the service applied no defaults. */
export interface InsertCommentParams {
  articleId: string
  /** The verified requester. Never taken from the request body. */
  userId: string
  content: string
  parentId: string | null
}

/**
 * What the insert statement actually did. `invalid_parent` is "zero rows came out",
 * which is the only signal the statement can give — the row was never written.
 *
 * The three failure kinds past `invalid_parent` are not hypothetical branches: they
 * are the `23503`s this statement can raise on a race, translated here because a
 * driver code must not climb toward a 5xx (stage A fixed that rule for `23505` in
 * `updateBySlug`). Each also maps to a *different* answer, which is why they are
 * not collapsed into one: a vanished author is an authentication failure, a
 * vanished article is the 404 the read path would have given, and a vanished parent
 * is the same invalid-reply-target the guard already refuses.
 */
export type InsertCommentResult =
  | { kind: 'created'; comment: CommentNode }
  | { kind: 'invalid_parent' }
  | { kind: 'author_missing' }
  | { kind: 'article_missing' }

export class CommentRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Chronological, flat.
   *
   * Ascending here even though the index is declared descending — Postgres scans
   * a btree backwards at the same cost, and threads read oldest-first.
   *
   * `id` breaks a `created_at` tie: `now()` is transaction-bound and two comments
   * can be stamped identically, and without a unique tiebreaker the same page can
   * return rows in different orders on repeat reads.
   *
   * No server-side tree building: nesting is shallow, and returning the rows flat
   * with a `parentId` keeps this to one indexed query. The client assembles.
   */
  async listForArticle(articleId: string): Promise<CommentNode[]> {
    const result = await this.pool.query<CommentRow>(
      `select ${commentColumns('c')}
         from comments c
         join users u on u.id = c.user_id
         where c.article_id = $1
         order by c.created_at asc, c.id asc`,
      [articleId],
    )

    return result.rows.map(toCommentNode)
  }

  /**
   * One comment by id, with its author, or null.
   *
   * The join is not for the response shape alone: the delete path has to compare
   * the *stored* author against the requester, and reading both in one statement
   * keeps that comparison from being made against two different snapshots.
   */
  async findById(id: string): Promise<CommentNode | null> {
    const result = await this.pool.query<CommentRow>(
      `select ${commentColumns('c')}
         from comments c
         join users u on u.id = c.user_id
         where c.id = $1
         limit 1`,
      [id],
    )

    const row = result.rows[0]
    return row === undefined ? null : toCommentNode(row)
  }

  /**
   * Insert a comment, refusing an illegitimate reply target *in the same statement*.
   *
   * The `where` clause is the parent rule (S3-R4): a reply lands only when
   * `parentId` is null, or when the parent exists AND hangs off the same article.
   * Doing it as "SELECT the parent, compare it in the service, then INSERT" is the
   * read-after-write shape stage A already had to reverse twice:
   * - the predicate is a fact about stored rows, so SQL owns it; a service-side copy
   *   would have to be re-implemented by every future writer, and one of them would
   *   forget;
   * - a parent deleted between the check and the insert would pass the check and
   *   then trip the `parent_id` foreign key — a `23503` climbing out of the driver
   *   as a 500. Here the guard and the write share one snapshot, so that window
   *   closes to "deleted after this statement's snapshot but before its own FK
   *   check", and even that is translated below instead of reaching the client.
   *
   * Zero rows out of the statement means the guard refused the insert: the same
   * "the statement reports what it did" contract `insertDraft` uses for slug
   * conflicts, so 400 INVALID_COMMENT_PARENT needs no pre-check to be race-free.
   * A nonexistent parent and a cross-article parent both land there — the reply
   * target is invalid either way, and splitting them into 400/404 would hand out an
   * oracle for which comment ids exist.
   *
   * `no_self_reply` (`parent_id <> id`) needs no defence here or in the service:
   * `id` is generated by `gen_random_uuid()` inside this statement, so no caller can
   * name the id its own comment is about to get. The constraint exists for writers
   * that *do* supply an id (migrations, psql, the publish CLI).
   *
   * The new row is read back out of the writing CTE rather than joined against
   * `comments`: the outer query of a data-modifying CTE sees the snapshot taken at
   * statement start, so joining the base table for the row the CTE itself just
   * inserted matches nothing — verified against the live database, where the join
   * silently returned zero rows and the service would have read that as a
   * rejected parent.
   */
  async insert(params: InsertCommentParams): Promise<InsertCommentResult> {
    try {
      // The `::uuid`/`::text` casts are load-bearing, not decoration. Under
      // `insert ... select`, Postgres cannot infer a parameter's type from the target
      // column the way it does for `insert ... values`, and answers an uncast `$3`
      // with `could not determine data type of parameter $3` — a 500 on every comment.
      const result = await this.pool.query<CommentRow>(
        `with inserted as (
           insert into comments (article_id, user_id, parent_id, content)
           select $1::uuid, $2::uuid, $3::uuid, $4::text
            where $3::uuid is null
               or exists (select 1 from comments p where p.id = $3::uuid and p.article_id = $1::uuid)
           returning id, article_id, user_id, parent_id, content, created_at
         )
         select ${commentColumns('i')}
           from inserted i
           join users u on u.id = i.user_id`,
        [params.articleId, params.userId, params.parentId, params.content],
      )

      const row = result.rows[0]
      if (row === undefined) return { kind: 'invalid_parent' }

      return { kind: 'created', comment: toCommentNode(row) }
    } catch (error) {
      const { code, constraint, message } = error as {
        code?: string
        constraint?: string
        message?: string
      }
      if (code !== '23503') throw error

      // The one window the guard cannot close on its own (see above), plus the two
      // rows this statement depends on and does not itself resolve: the article was
      // fetched by the service, and the author comes from the token — both can go
      // away before this insert runs. Postgres names the constraint that failed, and
      // that name is the only thing distinguishing the three, so the SQLSTATE is
      // translated here rather than becoming an opaque 500.
      //
      // `constraint` is preferred and `message` is the fallback: the driver exposes
      // the name as its own field, but a wrapped or older error may only carry it in
      // the text, and matching either is enough — an unmatched name rethrows.
      const named = `${constraint ?? ''}${message ?? ''}`
      if (named.includes('comments_parent_id_fkey')) return { kind: 'invalid_parent' }
      if (named.includes('comments_user_id_fkey')) return { kind: 'author_missing' }
      if (named.includes('comments_article_id_fkey')) return { kind: 'article_missing' }
      throw error
    }
  }

  /**
   * Remove by id; returns whether a row went away.
   *
   * No author check here — authorisation is a rule, and rules live in the service.
   * The caller has already resolved the comment and its author, so by the time this
   * runs "may this requester delete it" is settled; all that can still change
   * underneath is the row disappearing, which `false` reports as "nothing was
   * deleted" and the service answers 404. Deleting twice therefore converges on one
   * of {204, 404} for every interleaving.
   */
  async deleteById(id: string): Promise<boolean> {
    const result = await this.pool.query(`delete from comments where id = $1`, [id])
    return (result.rowCount ?? 0) > 0
  }
}

/** Shape of a row as Postgres returns it. Snake_case is correct here and only here. */
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

/** The one snake_case → camelCase translation for comments (architecture §1). */
function toCommentNode(row: CommentRow): CommentNode {
  return {
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
  }
}
