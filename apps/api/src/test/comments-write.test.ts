import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { FastifyInstance } from 'fastify'
import {
  ERROR_CODES,
  type ArticleAdmin,
  type CommentList,
  type CommentNode,
  type ErrorCode,
} from 'shared'
import { buildApp } from '../app.js'
import { CommentRepository } from '../modules/comments/repository.js'
import { COMMENT_MAX_LENGTH } from '../modules/comments/schema.js'
import { loadConfig } from '../config/index.js'
import { generateJti } from '../lib/tokens.js'
import { waitForRedis } from './wait-for-redis.js'

/**
 * Comment write path (S3 stage B): `POST /articles/:slug/comments` and
 * `DELETE /comments/:id`, against real Fastify + real Postgres + real Redis.
 *
 * Redis is not decoration: `requireAuth` consults the denylist, so every
 * authenticated request here needs a live client just to be authorised.
 *
 * Two things the suite is deliberately built around:
 * - the permission model is *not* the article one. Writing an article is
 *   admin-only; writing a comment is any-signed-in-user, so the reverse tests here
 *   assert 401/CSRF-403 and, on the other side, that a plain user gets 201. A
 *   "non-admin is 403" assertion copied from articles-write.test.ts would have
 *   asserted the wrong contract and passed while doing it.
 * - the database, not only the validator, holds the content rule (S3-R6). One test
 *   inserts an over-length row with raw SQL specifically to be rejected by
 *   Postgres; if it were rejected only by Zod the test would prove nothing about
 *   the other half of the pair.
 *
 * Articles used as hosts are created through stage A's write endpoints and then
 * published through it: going over HTTP keeps this suite honest about A still
 * working, where a hand-written `insert into articles` would test around it.
 */
let app: FastifyInstance
const config = loadConfig()

const users: { admin: string; author: string; other: string } = {
  admin: '',
  author: '',
  other: '',
}

/** Unique per run so concurrent/repeat runs never collide on a slug or login. */
const run = randomUUID().slice(0, 8)
const slugOf = (name: string): string => `cw-${run}-${name}`

const createdSlugs: string[] = []
function newSlug(name: string): string {
  const value = slugOf(name)
  createdSlugs.push(value)
  return value
}

function tokenFor(userId: string): string {
  return app.signAccessToken({ sub: userId, jti: generateJti() })
}

/** Credentials plus the CSRF header every write requires. */
function writeHeaders(userId: string): Record<string, string> {
  return { authorization: `Bearer ${tokenFor(userId)}`, 'x-requested-with': 'portal' }
}

function postComment(
  slug: string,
  body: unknown,
  headers: Record<string, string> = writeHeaders(users.author),
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/articles/${slug}/comments`,
    headers,
    payload: body as object,
  })
}

function deleteComment(id: string, headers: Record<string, string>) {
  return app.inject({ method: 'DELETE', url: `/api/v1/comments/${id}`, headers })
}

async function listComments(slug: string): Promise<{ status: number; body: CommentList }> {
  const response = await app.inject({ method: 'GET', url: `/api/v1/articles/${slug}/comments` })
  return { status: response.statusCode, body: response.json() as CommentList }
}

async function articleIdBySlug(value: string): Promise<string | null> {
  const { rows } = await app.db.query<{ id: string }>(
    `select id from articles where slug = $1`,
    [value],
  )
  return rows[0]?.id ?? null
}

/** Stage A's endpoints, because a comment needs an article that really exists. */
async function createdArticle(name: string, publish: boolean): Promise<string> {
  const value = newSlug(name)
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/articles',
    headers: writeHeaders(users.admin),
    payload: {
      slug: value,
      title: 'CW host',
      excerpt: 'e',
      content: 'c',
      category: 'Demo',
      tags: [],
    },
  })
  if (created.statusCode !== 201) {
    throw new Error(`fixture article create failed (${created.statusCode}): ${created.body}`)
  }

  if (publish) {
    const published = await app.inject({
      method: 'PATCH',
      url: `/api/v1/articles/${value}`,
      headers: writeHeaders(users.admin),
      payload: { status: 'published' },
    })
    if (published.statusCode !== 200) {
      throw new Error(`fixture article publish failed (${published.statusCode})`)
    }
    // Sanity on the fixture itself: a "published" host whose status we never
    // checked would make the draft 404s below pass for the wrong reason.
    expect((published.json() as ArticleAdmin).status).toBe('published')
  }

  return value
}

const publishedArticle = (name: string): Promise<string> => createdArticle(name, true)
const draftArticle = (name: string): Promise<string> => createdArticle(name, false)

beforeAll(async () => {
  if (process.env.DATABASE_URL === undefined || process.env.REDIS_URL === undefined) {
    throw new Error('DATABASE_URL and REDIS_URL are required for comment write tests')
  }

  app = await buildApp({ config })
  await waitForRedis(app)

  const inserted = await app.db.query<{ id: string; github_login: string }>(
    `insert into users (github_login, display_name, avatar_url, is_admin)
       values ($1, 'CW Admin', 'https://example.test/admin.png', true),
              ($2, 'CW Author', 'https://example.test/author.png', false),
              ($3, 'CW Other', null, false)
       returning id, github_login`,
    [`cw-admin-${run}`, `cw-author-${run}`, `cw-other-${run}`],
  )

  for (const row of inserted.rows) {
    if (row.github_login === `cw-admin-${run}`) users.admin = row.id
    else if (row.github_login === `cw-author-${run}`) users.author = row.id
    else users.other = row.id
  }
})

afterAll(async () => {
  // In afterAll, not at the end of a test body: a failed assertion mid-test would
  // otherwise leave these rows behind to poison the next run. Deleting an article
  // cascades its comments away (FK `on delete cascade`), so the many comments
  // created here — including the raw-SQL ones — need no separate sweep.
  if (app?.db) {
    for (const value of createdSlugs) {
      await app.db.query(`delete from articles where slug = $1`, [value])
    }
    // Login prefix rather than id: an empty id (if beforeAll itself failed) would
    // throw on a uuid cast and mask the real error. Sweeps orphans of earlier
    // crashed runs of this suite too.
    await app.db.query(`delete from users where github_login like 'cw-%'`)
  }
  await app?.close()
})

describe('POST /api/v1/articles/:slug/comments', () => {
  it('creates a comment as a plain signed-in user and returns the full node, joined author included', async () => {
    const slug = await publishedArticle('create')

    // Spoof attempt included: `user_id`/`authorId` are not contract fields, and the
    // identity must come from the token. `id` is offered too — the response's id
    // must be the database's, which is also what makes `no_self_reply`
    // unreachable from the API (test further down).
    const chosenId = randomUUID()
    const response = await postComment(slug, {
      content: '第一条评论',
      user_id: users.admin,
      authorId: users.admin,
      id: chosenId,
    })

    expect(response.statusCode).toBe(201)
    const node = response.json() as CommentNode

    expect(node.content).toBe('第一条评论')
    expect(node.parentId).toBeNull()
    expect(node.articleId).toBe(await articleIdBySlug(slug))
    expect(node.id).not.toBe(chosenId)

    // The author is who actually signed the request, not who the body claimed.
    expect(node.author.id).toBe(users.author)
    expect(node.author.login).toBe(`cw-author-${run}`)
    expect(node.author.displayName).toBe('CW Author')
    expect(node.author.avatarUrl).toBe('https://example.test/author.png')
    expect(typeof node.createdAt).toBe('string')

    // Exactly the contracted keys: no snake_case column escapes upward.
    expect(Object.keys(node).sort()).toEqual([
      'articleId',
      'author',
      'content',
      'createdAt',
      'id',
      'parentId',
    ])

    // No client-side reconstruction was needed: the create response and the list
    // agree on the same row, author included.
    const list = await listComments(slug)
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0]).toEqual(node)
  })

  it('accepts the two length boundaries and refuses both violations with 400', async () => {
    // S3-R6, application half: the DTO bound matches the database `check`, so a
    // violation is a 400 at the boundary rather than a constraint error surfacing
    // as a 5xx. Boundaries are tested, not just the middle: 1 and 4000 must land.
    const slug = await publishedArticle('length')

    expect((await postComment(slug, { content: '' })).statusCode).toBe(400)
    expect((await postComment(slug, { content: 'x'.repeat(COMMENT_MAX_LENGTH + 1) })).statusCode).toBe(
      400,
    )

    const empty = await postComment(slug, { content: '' })
    expect(empty.json().error.code).toBe(ERROR_CODES.badRequest)

    // Whitespace-only used to land: `length('   ')` is 3, so both the database
    // `check` and the DTO's own `min(1)` passed and a blank row was written. The
    // refine in `CreateCommentSchema` is what makes design §6's "空正文 → 400" true
    // rather than approximately true; it rejects without trimming, so what a reader
    // typed is still byte-for-byte what a reader sees.
    const whitespace = await postComment(slug, { content: '   ' })
    expect(whitespace.statusCode).toBe(400)
    expect(whitespace.json().error.code).toBe(ERROR_CODES.badRequest)

    const short = await postComment(slug, { content: 'x' })
    expect(short.statusCode).toBe(201)
    const long = await postComment(slug, { content: 'x'.repeat(COMMENT_MAX_LENGTH) })
    expect(long.statusCode).toBe(201)
    expect((long.json() as CommentNode).content).toHaveLength(COMMENT_MAX_LENGTH)
  })

  it('accepts a parentId from the same article and echoes it in the returned node', async () => {
    const slug = await publishedArticle('reply-same')

    const root = (await postComment(slug, { content: '根评论' })).json() as CommentNode
    const reply = (await postComment(slug, { content: '回复', parentId: root.id })).json() as CommentNode

    expect(reply.parentId).toBe(root.id)
    // Same article, different row: the tree is attached where it was asked.
    expect(reply.articleId).toBe(root.articleId)
    expect(reply.id).not.toBe(root.id)

    const list = await listComments(slug)
    expect(list.body.data.map((c) => c.parentId)).toEqual([null, root.id])
  })

  it('refuses a parentId on another article, and one that is not there, writing nothing', async () => {
    // S3-R4. Without this rule a caller could graft a tree onto someone else's
    // article, or walk comment ids to learn which exist on articles they cannot
    // see. Both shapes answer the same 400: splitting them into 400/404 would be
    // an existence oracle for a resource that is not the caller's to probe.
    const first = await publishedArticle('parent-first')
    const second = await publishedArticle('parent-second')

    const root = (await postComment(first, { content: '属于第一篇文章' })).json() as CommentNode

    const crossArticle = await postComment(second, { content: '挂错文章', parentId: root.id })
    expect(crossArticle.statusCode).toBe(400)
    expect(crossArticle.json().error.code).toBe(ERROR_CODES.invalidCommentParent)

    const ghost = await postComment(first, { content: '回复不存在的评论', parentId: randomUUID() })
    expect(ghost.statusCode).toBe(400)
    expect(ghost.json().error.code).toBe(ERROR_CODES.invalidCommentParent)

    // Control on `second`: it is commentable, so the 400 above came from the
    // parent and not from the host article. Without this the two failures would
    // look identical and a broken host would "pass" the cross-article assertion.
    const plainOnSecond = await postComment(second, { content: '正常评论' })
    expect(plainOnSecond.statusCode).toBe(201)

    // The rejected requests left no trace: `second` has the one accepted comment,
    // `first` still has only its root.
    expect((await listComments(second)).body.data).toHaveLength(1)
    expect((await listComments(first)).body.data).toHaveLength(1)
  })

  it('answers 404 for a draft and for an unknown slug, and inserts nothing for either', async () => {
    // Reuses `ArticleService.findPublished`, so a comment cannot be attached to a
    // draft even though the poster is authenticated and the draft's slug is public
    // knowledge to its author. Same answer as the article detail endpoint, by
    // construction rather than by a copied condition.
    const draft = await draftArticle('draft-host')
    const before = await articleIdBySlug(draft)
    expect(before).not.toBeNull()

    const onDraft = await postComment(draft, { content: '不该存在' })
    expect(onDraft.statusCode).toBe(404)
    expect(onDraft.json().error.code).toBe(ERROR_CODES.articleNotFound)
    // The 404 aborted before the insert: no orphan waits on a private article.
    expect((await listComments(draft)).status).toBe(404)
    const { rows } = await app.db.query<{ n: string }>(
      `select count(*)::text as n from comments where article_id = $1`,
      [before],
    )
    expect(rows[0]?.n).toBe('0')

    const missing = await postComment(slugOf('no-such-article'), { content: 'x' })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.code).toBe(ERROR_CODES.articleNotFound)
  })

  it('keeps the list order created_at asc, id asc — including when timestamps tie', async () => {
    const slug = await publishedArticle('ordering')
    const articleId = await articleIdBySlug(slug)
    expect(articleId).not.toBeNull()

    const first = (await postComment(slug, { content: '一' })).json() as CommentNode
    const second = (await postComment(slug, { content: '二' })).json() as CommentNode
    const third = (await postComment(slug, { content: '三' })).json() as CommentNode

    // Two rows stamped identically on purpose, with ids chosen so lexicographic id
    // order is the opposite of insertion order. `now()` is transaction-bound, so
    // ties are real; without the `id` tiebreaker this page could reorder itself
    // between reads.
    const tieStamp = new Date('2020-01-01T00:00:00.000Z')
    const laterId = randomUUID()
    const earlierId = randomUUID()
    const [lowId, highId] = [earlierId, laterId].sort()
    for (const id of [highId, lowId]) {
      await app.db.query(
        `insert into comments (id, article_id, user_id, content, created_at)
           values ($1, $2, $3, $4, $5)`,
        [id, articleId, users.other, `tied-${id}`, tieStamp],
      )
    }

    const list = await listComments(slug)
    expect(list.status).toBe(200)

    /**
     * What is asserted is the read path's `order by created_at asc, id asc`: a
     * non-decreasing `createdAt` with `id` as the tiebreaker — not strictly
     * increasing timestamps. `created_at` comes from `now()`, which is
     * transaction-bound, so two comments written inside one transaction would carry
     * an identical stamp and only the `id` key orders them; that tie is what the
     * raw-SQL pair below feeds in, deliberately and with ids chosen opposite to
     * insertion order. The three API comments are separate requests, hence separate
     * transactions milliseconds apart, so they land in creation order.
     *
     * The last element being `third` is also the "a new comment appears at the end
     * of the list" half of the contract, so this single assertion covers both.
     */
    expect(list.body.data.map((c) => c.id)).toEqual([lowId, highId, first.id, second.id, third.id])
  })
})

describe('DELETE /api/v1/comments/:id', () => {
  it('lets the author delete their own comment, and answers 404 the second time', async () => {
    const slug = await publishedArticle('author-delete')
    const node = (await postComment(slug, { content: '我自己删' })).json() as CommentNode

    const deleted = await deleteComment(node.id, writeHeaders(users.author))
    expect(deleted.statusCode).toBe(204)
    expect(deleted.body).toBe('')

    expect((await listComments(slug)).body.data).toHaveLength(0)

    const again = await deleteComment(node.id, writeHeaders(users.author))
    expect(again.statusCode).toBe(404)
    expect(again.json().error.code).toBe(ERROR_CODES.notFound)
  })

  it('refuses another signed-in non-admin with 403 and leaves the comment intact', async () => {
    // The 403-vs-404 choice is deliberate and differs from a draft article's 404;
    // the reasoning is written at `CommentService.remove` and in design §2 — a
    // comment id is a non-enumerable uuid, so "this exists but is not yours" leaks
    // nothing a holder of the id did not already have, while a guessable article
    // slug must not confirm that an unpublished draft is there.
    const slug = await publishedArticle('stranger-delete')
    const node = (await postComment(slug, { content: '别人的评论' })).json() as CommentNode

    const denied = await deleteComment(node.id, writeHeaders(users.other))
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error.code).toBe(ERROR_CODES.forbidden)

    // Control that the refusal actually aborted the write: the comment is still
    // listed, and its author can still delete it. A 403 thrown *after* a delete
    // would satisfy the status assertion above and be a real defect.
    expect((await listComments(slug)).body.data.map((c) => c.id)).toEqual([node.id])
    expect((await deleteComment(node.id, writeHeaders(users.author))).statusCode).toBe(204)
  })

  it('lets an administrator delete another user’s comment (closes defect D8’s permission half)', async () => {
    // D8 is about RLS: the Supabase-era policy allowed only
    // `delete ... using (auth.uid() = user_id)`, so even the site owner could not
    // remove a comment belonging to someone else. Here the rule is author *or*
    // `users.is_admin`, read from the database per request.
    const slug = await publishedArticle('admin-delete')
    const node = (await postComment(slug, { content: '需要管理员删除' })).json() as CommentNode

    const removed = await deleteComment(node.id, writeHeaders(users.admin))
    expect(removed.statusCode).toBe(204)

    // Symmetric check: gone for the author too, i.e. the row really went away.
    expect((await listComments(slug)).body.data).toHaveLength(0)
    expect((await deleteComment(node.id, writeHeaders(users.author))).statusCode).toBe(404)
  })

  it('answers 404 for a uuid that is not there and 400 for one that cannot be', async () => {
    const missing = await deleteComment(randomUUID(), writeHeaders(users.admin))
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.code).toBe(ERROR_CODES.notFound)

    // The params schema is a uuid, so garbage is refused as 400 at the boundary
    // instead of reaching Postgres and failing as a uuid-cast 500.
    const malformed = await deleteComment('not-a-uuid', writeHeaders(users.admin))
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json().error.code).toBe(ERROR_CODES.badRequest)
  })

  it('answers 404 for a reply whose parent thread was cascaded away', async () => {
    // `parent_id ... on delete cascade` means deleting a root takes its replies
    // with it, so the second delete has nothing left to act on. Recorded here
    // because the behaviour is a consequence of the schema, not of a check in the
    // service: the endpoint gives the same 404 as "never existed", and that is the
    // intended whole answer.
    const slug = await publishedArticle('cascade')
    const root = (await postComment(slug, { content: '父' })).json() as CommentNode
    const reply = (await postComment(slug, { content: '子', parentId: root.id })).json() as CommentNode

    expect((await deleteComment(root.id, writeHeaders(users.author))).statusCode).toBe(204)

    const gone = await deleteComment(reply.id, writeHeaders(users.author))
    expect(gone.statusCode).toBe(404)
    expect(gone.json().error.code).toBe(ERROR_CODES.notFound)
    expect((await listComments(slug)).body.data).toHaveLength(0)
  })

  it('treats a vanished account as non-admin and refuses it with 403, not 401', async () => {
    // The `isAdmin === null` branch of `AuthRepository.isAdmin`, reached by the only
    // shape that produces it: a still-valid access token for a user row that is
    // already gone. `requireAdmin` answers that with 401, because for an admin route
    // the missing account *is* the whole question. Here the admin read only feeds the
    // or-branch of an authorisation rule — `requireAuth` already accepted the token —
    // and the authorship branch cannot have matched either, since deleting a user
    // cascades their comments away. So: 403, and the comment stays.
    const slug = await publishedArticle('ghost-admin')
    const node = (await postComment(slug, { content: '作者还在' })).json() as CommentNode

    const inserted = await app.db.query<{ id: string }>(
      `insert into users (github_login, display_name, is_admin)
         values ($1, 'CW Vanished', false) returning id`,
      [`cw-ghost-${run}`],
    )
    const ghostId = inserted.rows[0]!.id
    const headers = writeHeaders(ghostId)

    // The account is really gone before the request, so the token's `sub` resolves
    // to nothing; without this the test would only be exercising an ordinary 403.
    await app.db.query(`delete from users where id = $1`, [ghostId])

    const denied = await deleteComment(node.id, headers)
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error.code).toBe(ERROR_CODES.forbidden)

    // Control: the refusal deleted nothing.
    expect((await listComments(slug)).body.data.map((c) => c.id)).toEqual([node.id])
  })
})

describe('the database check holds the content rule too (S3-R6)', () => {
  it('rejects an over-length insert that never passes through the DTO', async () => {
    const slug = await publishedArticle('db-check')
    const articleId = await articleIdBySlug(slug)
    expect(articleId).not.toBeNull()

    // Deliberately bypasses the API: what is being proved is that the constraint is
    // in the schema, so some other writer (a migration, psql, the publish CLI)
    // cannot store what the validator would have refused.
    let captured: unknown
    try {
      await app.db.query(
        `insert into comments (article_id, user_id, content) values ($1, $2, $3)`,
        [articleId, users.author, 'x'.repeat(5000)],
      )
    } catch (error) {
      captured = error
    }

    const violation = captured as { code?: string; message?: string }
    expect(violation.code, 'database did not reject the over-length insert').toBe('23514')
    expect(String(violation.message)).toContain('comments_content_check')

    // Control: the same statement at the boundary succeeds, so the rejection above
    // is the length rule and not a broken query or a missing fixture.
    const ok = await app.db.query(
      `insert into comments (article_id, user_id, content) values ($1, $2, $3) returning id`,
      [articleId, users.author, 'x'.repeat(COMMENT_MAX_LENGTH)],
    )
    expect(ok.rows).toHaveLength(1)

    // And it is served back through the read path, proving the row is real.
    const list = await listComments(slug)
    expect(list.body.data.some((c) => c.content.length === COMMENT_MAX_LENGTH)).toBe(true)
  })

  it('rejects a self-parented row, which the API cannot even ask for', async () => {
    // `no_self_reply` (`parent_id is null or parent_id <> id`) is not reachable
    // through `POST`: the id comes from `gen_random_uuid()` inside the insert, the
    // body schema has no `id` field (and the create test above proves a supplied one
    // is ignored), so no request can make a row point at itself — there is no id to
    // name before the row exists. That is the reasoning this test pins down, and it
    // is *not* a licence to weaken the constraint: it fires for the writers that do
    // supply ids, which is exactly what is asserted here.
    const slug = await publishedArticle('self-reply')
    const articleId = await articleIdBySlug(slug)
    const id = randomUUID()
    expect(articleId).not.toBeNull()

    let captured: unknown
    try {
      await app.db.query(
        `insert into comments (id, article_id, user_id, parent_id, content)
           values ($1, $2, $3, $1, '自我回复')`,
        [id, articleId, users.author],
      )
    } catch (error) {
      captured = error
    }

    const violation = captured as { code?: string; message?: string }
    expect(violation.code, 'database did not reject the self-parented insert').toBe('23514')
    expect(String(violation.message)).toContain('no_self_reply')

    // Control: the identical statement with no parent inserts fine, so the failure
    // is the constraint and not the fixture.
    const ok = await app.db.query(
      `insert into comments (id, article_id, user_id, parent_id, content)
         values ($1, $2, $3, null, '正常根评论') returning id`,
      [id, articleId, users.author],
    )
    expect(ok.rows).toHaveLength(1)
  })
})

describe('write endpoints authentication — reverse tests', () => {
  /** The injected response type, spelled from `app.inject` rather than imported. */
  type Injected = Awaited<ReturnType<typeof app.inject>>

  /**
   * Both targets have to point at rows that really exist, and every refusal has to
   * be bracketed by a check that nothing changed.
   *
   * The version this replaces posted to an article that was never there and deleted
   * a `randomUUID()` that never was. Against absent rows, "the guard refused first"
   * and "the write was attempted and fell over on its own" produce the same 401, so
   * the two assertions below are the whole point of these rows — status and `code`
   * alone would survive a refactor that moved `requireCsrfHeader` to after the
   * insert. `articles-write.test.ts` had the identical hole and was fixed the same
   * way; this file is the one that still had it.
   */
  let liveSlug = ''
  let liveCommentId = ''

  const commentCount = async (): Promise<number> => {
    const { rows } = await app.db.query<{ n: string }>(
      `select count(*)::text as n from comments where article_id = (select id from articles where slug = $1)`,
      [liveSlug],
    )
    return Number(rows[0]!.n)
  }

  const commentStillThere = async (): Promise<boolean> => {
    const { rows } = await app.db.query<{ id: string }>(
      `select id from comments where id = $1`,
      [liveCommentId],
    )
    return rows.length === 1
  }

  beforeAll(async () => {
    liveSlug = await publishedArticle('authz-live')
    liveCommentId = ((await postComment(liveSlug, { content: '一条真实的评论' }, writeHeaders(users.author))).json() as CommentNode).id
  })

  const targets: {
    name: string
    run: (headers: Record<string, string>) => Promise<Injected>
    untouched: () => Promise<void>
  }[] = [
    {
      name: 'POST comment',
      run: (headers) => postComment(liveSlug, { content: 'x' }, headers),
      // One row exists — the one this block created. A refused POST must not add a
      // second, and the count is asserted rather than inferred from the status.
      untouched: async () => {
        expect(await commentCount()).toBe(1)
      },
    },
    {
      name: 'DELETE comment',
      run: (headers) => deleteComment(liveCommentId, headers),
      untouched: async () => {
        expect(await commentStillThere()).toBe(true)
      },
    },
  ]

  for (const { name, run, untouched } of targets) {
    it(`${name} without any credentials is 401 and writes nothing`, async () => {
      const response = await run({})
      expect(response.statusCode).toBe(401)
      expect(response.json().error.code).toBe(ERROR_CODES.unauthorized)
      await untouched()
    })
  }

  for (const { name, run, untouched } of targets) {
    it(`${name} with credentials but no CSRF header is 403 CSRF_CHECK_FAILED and writes nothing`, async () => {
      // The header requirement is on DELETE exactly as on POST (design §5's named
      // trap), and it is the *last* line: these requests carry a valid token, so
      // reaching the header check at all is part of what is being proved.
      const response = await run({ authorization: `Bearer ${tokenFor(users.author)}` })
      expect(response.statusCode).toBe(403)
      expect(response.json().error.code).toBe(ERROR_CODES.csrfCheckFailed)
      await untouched()
    })
  }

  it('a signed-in non-admin is NOT refused: commenting is a reader action', async () => {
    // Explicitly the opposite of the articles-write assertions, so the difference
    // is written down somewhere a future "consistency" pass will read: article
    // writes are requireAdmin, comment writes are requireAuth. A copied 403 here
    // would break the feature, not the test.
    const slug = await publishedArticle('plain-user-allowed')
    const response = await postComment(slug, { content: '普通用户发的' }, writeHeaders(users.other))
    expect(response.statusCode).toBe(201)
    expect((response.json() as CommentNode).author.id).toBe(users.other)
  })

  it('refuses a comment from an account that no longer exists, as 401', async () => {
    // A still-valid token for a deleted user reaches the insert, whose `user_id`
    // foreign key then refuses the row. The service reads that as the authentication
    // failure it is — the same reading `requireAdmin` gives a null `isAdmin` — rather
    // than letting a `23503` become a 500. Asserted as 401 *and* as "nothing
    // written", because the code alone would also be returned by a missing token.
    const slug = await publishedArticle('vanished-author')
    const articleId = await articleIdBySlug(slug)
    const inserted = await app.db.query<{ id: string }>(
      `insert into users (github_login, display_name, is_admin)
         values ($1, 'CW Doomed', false) returning id`,
      [`cw-doomed-${run}`],
    )
    const doomed = inserted.rows[0]!.id
    const headers = writeHeaders(doomed)

    await app.db.query(`delete from users where id = $1`, [doomed])

    const response = await postComment(slug, { content: '账号已注销' }, headers)
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe(ERROR_CODES.unauthorized)
    for (const leaked of ['23503', '23505', '23514']) {
      expect(response.body).not.toContain(leaked)
    }

    const { rows } = await app.db.query<{ n: string }>(
      `select count(*)::text as n from comments where article_id = $1 and user_id = $2`,
      [articleId, doomed],
    )
    expect(rows[0]?.n).toBe('0')
  })

  it('an error response carries the envelope and never a driver code', async () => {
    const slug = await publishedArticle('envelope')
    const cross = await publishedArticle('envelope-other')
    const root = (await postComment(slug, { content: '根' })).json() as CommentNode

    const response = await postComment(cross, { content: '错父', parentId: root.id })
    const body = response.json() as { error: { code: ErrorCode; message: string; requestId: string } }

    expect(response.statusCode).toBe(400)
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'requestId'])
    expect(typeof body.error.requestId).toBe('string')
    // The parent guard is expressed in SQL, but the SQLSTATE that *would* have
    // backed a check-then-write version never reaches the wire (design §1.2).
    for (const leaked of ['23503', '23505', '23514', 'FST_ERR']) {
      expect(response.body).not.toContain(leaked)
    }
  })
})

describe('a foreign key deleted mid-request is translated, never a 500', () => {
  it('reports article_missing when the row the service resolved disappears first', async () => {
    // Proven at the repository, not over HTTP: the window is "the service read the
    // article, then someone deleted it, then the insert ran", which cannot be
    // scheduled deterministically through three request handlers. Stage A learned
    // this the hard way — an HTTP-level race is a sentinel, the deterministic
    // evidence belongs one layer down. What is under test is that the `23503`
    // Postgres raises for `comments_article_id_fkey` is named and translated rather
    // than thrown at the caller as an internal error.
    const slug = await publishedArticle('fk-article')
    const articleId = await articleIdBySlug(slug)
    expect(articleId).not.toBeNull()
    const repo = new CommentRepository(app.db)

    // Control first: against a live article the same call inserts.
    const live = await repo.insert({
      articleId: articleId!,
      userId: users.author,
      content: 'c',
      parentId: null,
    })
    expect(live.kind).toBe('created')

    await app.db.query(`delete from articles where slug = $1`, [slug])

    const raced = await repo.insert({
      articleId: articleId!,
      userId: users.author,
      content: '写给已消失的文章',
      parentId: null,
    })
    expect(raced.kind).toBe('article_missing')

    // The third FK, `comments_parent_id_fkey`, is deliberately not tested here:
    // reaching it needs a parent deleted between this statement's own snapshot and
    // its FK check, which no fixture can schedule. It is translated by the same
    // branch as the other two, and the *observable* parent problems — a comment on
    // another article, a uuid that never existed — are covered by the guard itself
    // above, which is the path a request can actually take.
  })
})

describe('structural guard: comment SQL lives only in the repository', () => {
  it('the insert/delete statements appear in no layer but repository.ts', async () => {
    // Layering rule (architecture §1): routes and services must not speak SQL, and
    // the driver-code translation belongs to whichever layer knows SQL at all. The
    // stage A guard covers the articles module; this one covers comments, because a
    // guard scoped to a different module would say nothing about the code added now.
    //
    // A zero-match grep is indistinguishable from a grep that looked at nothing, so
    // the same pathspec doubles as the control (see verification-checklist).
    let out: string
    try {
      out = execFileSync(
        'git',
        [
          'grep',
          '-l',
          '-E',
          'insert into comments|update comments|delete from comments',
          '--',
          // `:/` anchors at the repo root; a bare path resolves against the vitest
          // cwd (apps/api) and would scan apps/api/apps/api/src — empty.
          ':/apps/api/src/modules/comments',
        ],
        { encoding: 'utf8', cwd: process.cwd() },
      )
    } catch (error) {
      const { status, stderr } = error as { status?: number; stderr?: string }
      if (status !== 1) {
        throw new Error(`git grep could not run (status ${status}): ${stderr ?? ''}`, { cause: error })
      }
      out = ''
    }

    const files = out
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)

    expect(files.every((f) => f.endsWith('repository.ts'))).toBe(true)
    expect(files.length, 'pathspec matched no file; the guard above is vacuous').toBeGreaterThan(0)
  })
})
