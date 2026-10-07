import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { ERROR_CODES, type ArticleAdmin, type ArticlePage, type CommentList } from 'shared'
import { buildApp } from '../app.js'
import { ArticleRepository } from '../modules/articles/repository.js'
import { loadConfig } from '../config/index.js'
import { generateJti } from '../lib/tokens.js'
import { waitForRedis } from './wait-for-redis.js'

/**
 * Article write path (S3 stage A).
 *
 * Real Fastify + real Postgres + real Redis: `requireAdmin` reaches the denylist
 * through `requireAuth`, so an admin-token request needs a live Redis just to be
 * authorised — this is an end-to-end integration suite, not a unit test.
 *
 * Scope is deliberately the article write surface only. Comment *writes* land in
 * stage B, so the one place a comment is needed (the slug-rename/does-it-orphan
 * proof, S3-R2) inserts it with raw SQL: what is under test here is the foreign
 * key, and that exists whether or not a comment POST endpoint does yet.
 */
let app: FastifyInstance
const config = loadConfig()

const users: { admin: string; plain: string } = { admin: '', plain: '' }

/** Unique per run so concurrent/repeat runs never collide on a slug. */
const run = randomUUID().slice(0, 8)
const slug = (name: string): string => `aw-${run}-${name}`

// Every slug this file writes is tracked so afterAll can remove exactly them,
// regardless of how a test failed partway through.
const createdSlugs: string[] = []
function newSlug(name: string): string {
  const value = slug(name)
  createdSlugs.push(value)
  return value
}

function tokenFor(userId: string): string {
  return app.signAccessToken({ sub: userId, jti: generateJti() })
}

/** Admin credentials plus the CSRF header every write requires. */
function adminHeaders(): Record<string, string> {
  return { authorization: `Bearer ${tokenFor(users.admin)}`, 'x-requested-with': 'portal' }
}

async function postArticle(body: unknown, headers = adminHeaders()) {
  return app.inject({ method: 'POST', url: '/api/v1/articles', headers, payload: body as object })
}

async function patchArticle(target: string, body: unknown, headers = adminHeaders()) {
  return app.inject({ method: 'PATCH', url: `/api/v1/articles/${target}`, headers, payload: body as object })
}

async function deleteArticle(target: string, headers = adminHeaders()) {
  return app.inject({ method: 'DELETE', url: `/api/v1/articles/${target}`, headers })
}

async function getJson<T>(url: string) {
  const response = await app.inject({ method: 'GET', url })
  return { status: response.statusCode, body: response.json() as T }
}

/** The stored id of an article by slug — needed to hang a comment off the FK. */
async function articleIdBySlug(value: string): Promise<string | null> {
  const { rows } = await app.db.query<{ id: string }>(`select id from articles where slug = $1`, [value])
  return rows[0]?.id ?? null
}

/**
 * Total rows in `articles`, for the "the refusal wrote nothing" proofs.
 *
 * A global count is meaningful here only because `vitest.config.ts` sets
 * `fileParallelism: false`, so no other test file writes while this one runs. It is
 * always compared against itself before/after and never to a hard-coded number, so
 * what other suites leave behind cannot break the assertion — the same shape
 * `articleCount()` has in `articles-import.test.ts`.
 */
async function articleCount(): Promise<number> {
  const { rows } = await app.db.query<{ n: number }>('select count(*)::int as n from articles')
  return rows[0]!.n
}

interface StoredArticle {
  slug: string
  title: string
}

/** The stored row behind a slug: the fields a refused write must not move. */
async function storedArticle(value: string): Promise<StoredArticle | null> {
  const { rows } = await app.db.query<StoredArticle>(
    `select slug, title from articles where slug = $1`,
    [value],
  )
  return rows[0] ?? null
}

/**
 * A "the row is still there and still says exactly what it said" control.
 *
 * Snapshots now and returns the checker to run after the refused call, so a guard
 * that answers 401/403 *after* doing the damage passes the status assertion and
 * fails this one. Snapshotting inside the returned closure instead would compare
 * the damage against itself and assert nothing at all.
 */
async function rowUntouched(value: string, why: string): Promise<() => Promise<void>> {
  const before = await storedArticle(value)
  // Without this the `toEqual` below would compare `null` with `null` and pass on a
  // fixture that was never created — an empty assertion wearing a green badge (the
  // trap `storedRows([])` refuses to walk into in articles-import.test.ts).
  if (before === null) {
    throw new Error(`fixture row ${value} is missing; the untouched-check would assert on nothing`)
  }

  return async () => {
    const after = await storedArticle(value)
    expect(after, `${why}: ${value} is gone`).not.toBeNull()
    expect(after, why).toEqual(before)
  }
}

/** Body every fixture here uses; `title` is what the untouched-check reads back. */
const fixture = { title: 'Pristine', excerpt: 'e', content: 'c', category: 'D', tags: [] }

/** Creates the row a refused PATCH/DELETE must leave alone. */
async function createTarget(value: string): Promise<void> {
  const created = await postArticle({ slug: value, ...fixture })
  if (created.statusCode !== 201) {
    throw new Error(`fixture ${value} was not created (got ${created.statusCode}: ${created.body})`)
  }
}

/** A refused write: the call, the row it needs beforehand, and the proof it did not land. */
interface WriteRefusal {
  name: string
  /** Sets up `value` as the row this call is refused against. */
  prepare: (value: string) => Promise<void>
  run: (value: string, headers: Record<string, string>) => Promise<LightMyRequestResponse>
  guard: (value: string) => Promise<() => Promise<void>>
}

/**
 * One fixture row per (verb, refusal) pair, keyed by the test's own label.
 *
 * Sharing a single target across the three refusals would let an earlier red poison
 * a later one's baseline: once a mutation had already rewritten the title, the next
 * test would snapshot the damaged value and pass by comparing damage with damage.
 * `newSlug` registers every name here, so all of it still falls inside `afterAll`'s
 * sweep by slug.
 */
function ownTarget(name: string, refusal: string): string {
  return newSlug(`${name}-${refusal}`.toLowerCase())
}

beforeAll(async () => {
  if (process.env.DATABASE_URL === undefined || process.env.REDIS_URL === undefined) {
    throw new Error('DATABASE_URL and REDIS_URL are required for article write tests')
  }

  app = await buildApp({ config })
  await waitForRedis(app)

  const inserted = await app.db.query<{ id: string; github_login: string }>(
    `insert into users (github_login, display_name, is_admin)
       values ($1, 'AW Admin', true), ($2, 'AW Plain', false)
       returning id, github_login`,
    [`aw-admin-${run}`, `aw-plain-${run}`],
  )
  for (const row of inserted.rows) {
    if (row.github_login === `aw-admin-${run}`) users.admin = row.id
    else users.plain = row.id
  }
})

afterAll(async () => {
  // In afterAll, not at the end of a test body: a failed assertion mid-test would
  // otherwise leave these rows behind to poison the next run (see authz.test.ts).
  // Deleting an article cascades its comments away, so the comment inserted by
  // hand for the slug-rename proof needs no separate cleanup.
  if (app?.db) {
    for (const value of createdSlugs) {
      await app.db.query(`delete from articles where slug = $1`, [value])
    }
    // Login prefix, not id: an empty id (if beforeAll itself failed) would throw
    // on a uuid cast and mask the real error. This also sweeps orphans from any
    // earlier crashed run of the same suite.
    await app.db.query(`delete from users where github_login like 'aw-%'`)
  }
  await app?.close()
})

describe('POST /api/v1/articles', () => {
  it('creates a draft, invisible to the public list and detail, until published', async () => {
    const value = newSlug('lifecycle')

    const created = await postArticle({
      slug: value,
      title: 'Lifecycle',
      excerpt: 'first',
      content: 'body one',
      category: 'Demo',
      tags: ['demo'],
    })
    expect(created.statusCode).toBe(201)

    // Created as a draft, with no publication timestamp.
    const draft = created.json() as ArticleAdmin
    expect(draft.slug).toBe(value)
    expect(draft.status).toBe('draft')
    expect(draft.publishedAt).toBeNull()
    // The admin view carries `status`/`updatedAt` the public shape never shows.
    expect(typeof draft.updatedAt).toBe('string')

    // Not readable publicly while a draft — detail and list both agree.
    expect((await getJson(`/api/v1/articles/${value}`)).status).toBe(404)
    const hidden = await getJson<ArticlePage>('/api/v1/articles?limit=50')
    expect(hidden.body.data.map((a) => a.slug)).not.toContain(value)

    // Publish through PATCH (the only endpoint that can move status).
    const published = await patchArticle(value, { status: 'published' })
    expect(published.statusCode).toBe(200)
    const pub = published.json() as ArticleAdmin
    expect(pub.status).toBe('published')
    expect(pub.publishedAt).not.toBeNull()

    // Now the public surface serves it.
    const detail = await getJson<ArticleAdmin>(`/api/v1/articles/${value}`)
    expect(detail.status).toBe(200)
    const shown = await getJson<ArticlePage>('/api/v1/articles?limit=50')
    expect(shown.body.data.map((a) => a.slug)).toContain(value)

    // Update a field; the body change is reflected.
    const edited = await patchArticle(value, { title: 'Renamed', content: 'body two' })
    expect(edited.statusCode).toBe(200)
    expect((edited.json() as ArticleAdmin).title).toBe('Renamed')

    // Delete → gone from the public detail.
    const removed = await deleteArticle(value)
    expect(removed.statusCode).toBe(204)
    expect((await getJson(`/api/v1/articles/${value}`)).status).toBe(404)
  })

  it('honours a client-supplied status of "published" by still creating a draft', async () => {
    // S3-R0 / design §1.1: creation never publishes. The validator strips the
    // unknown key, so a client trying to seed a published article by naming it
    // gets a draft instead.
    const value = newSlug('ignore-status')

    const response = await postArticle({
      slug: value,
      title: 'Sneaky',
      excerpt: 'x',
      content: 'y',
      category: 'Demo',
      tags: [],
      status: 'published',
    })
    expect(response.statusCode).toBe(201)

    const created = response.json() as ArticleAdmin
    expect(created.status).toBe('draft')
    expect(created.publishedAt).toBeNull()
  })
})

describe('PATCH status transitions (S3-R1)', () => {
  it('stamps published_at on first publish, never re-stamps it, and keeps it on demotion', async () => {
    const value = newSlug('transitions')

    await postArticle({ slug: value, title: 'T', excerpt: 'e', content: 'c', category: 'D', tags: [] })

    // draft -> published sets published_at.
    const first = (await patchArticle(value, { status: 'published' })).json() as ArticleAdmin
    expect(first.status).toBe('published')
    expect(first.publishedAt).not.toBeNull()

    // Editing content while published must not move the first-publish time.
    const edited = (await patchArticle(value, { title: 'T2', content: 'c2' })).json() as ArticleAdmin
    expect(edited.publishedAt).toBe(first.publishedAt)

    // Re-sending status published is a no-op for the timestamp too (already set).
    const again = (await patchArticle(value, { status: 'published' })).json() as ArticleAdmin
    expect(again.publishedAt).toBe(first.publishedAt)

    // published -> draft PRESERVES published_at (it records "was once published").
    const demoted = (await patchArticle(value, { status: 'draft' })).json() as ArticleAdmin
    expect(demoted.status).toBe('draft')
    expect(demoted.publishedAt).toBe(first.publishedAt)

    // The three-step flow the prd calls out: published -> archived -> published.
    // Archive keeps the timestamp; re-publishing must NOT re-stamp it either —
    // "first publish" is exactly that, the second publish is not the first.
    const archived = (await patchArticle(value, { status: 'archived' })).json() as ArticleAdmin
    expect(archived.status).toBe('archived')
    expect(archived.publishedAt).toBe(first.publishedAt)

    const republished = (await patchArticle(value, { status: 'published' })).json() as ArticleAdmin
    expect(republished.status).toBe('published')
    expect(republished.publishedAt).toBe(first.publishedAt)
  })

  it('never overwrites the first-publish time when two publishes race on a fresh draft', async () => {
    // End-to-end sentinel for the concurrent-first-publish scenario: two PATCHes
    // read the draft, both decide to stamp, and the repository must land exactly
    // one timestamp that both responses agree on. Honest caveat: with a plain
    // (non-coalesce) write this could still pass if both stamps fall in the same
    // millisecond — the deterministic proof of the race-free write is the
    // stale-candidate repository test below, which uses fixed timestamps.
    const value = newSlug('publish-race')
    await postArticle({ slug: value, title: 'R', excerpt: 'e', content: 'c', category: 'D', tags: [] })

    const [a, b] = await Promise.all([
      patchArticle(value, { status: 'published' }),
      patchArticle(value, { status: 'published' }),
    ])
    expect(a.statusCode).toBe(200)
    expect(b.statusCode).toBe(200)

    const pa = a.json() as ArticleAdmin
    const pb = b.json() as ArticleAdmin
    expect(pa.publishedAt).not.toBeNull()
    expect(pb.publishedAt).toBe(pa.publishedAt)
  })

  it('answers 404 ARTICLE_NOT_FOUND for an unknown slug', async () => {
    const response = await patchArticle(slug('does-not-exist'), { title: 'ghost' })
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe(ERROR_CODES.articleNotFound)
  })
})

describe('PATCH with an empty body', () => {
  it('returns 200 with the stored record and leaves updated_at untouched', async () => {
    // A patch carrying nothing changed nothing, so it must not bump `updated_at`
    // — the same "content unchanged then row unchanged" discipline S3-R9 demands
    // of the publish pipeline, applied to the interactive write path.
    const value = newSlug('empty-patch')
    const created = (await postArticle({
      slug: value,
      title: 'E',
      excerpt: 'e',
      content: 'c',
      category: 'D',
      tags: [],
    })).json() as ArticleAdmin

    const response = await patchArticle(value, {})
    expect(response.statusCode).toBe(200)

    const after = response.json() as ArticleAdmin
    expect(after.slug).toBe(value)
    expect(after.title).toBe(created.title)
    expect(after.status).toBe('draft')
    expect(after.updatedAt).toBe(created.updatedAt)
  })
})

describe('slug rename keeps comments (S3-R2 / D10)', () => {
  it('moves the article to a new slug without orphaning its comment', async () => {
    const oldSlug = newSlug('comment-old')
    const newSlugValue = newSlug('comment-new')

    await postArticle({ slug: oldSlug, title: 'Commented', excerpt: 'e', content: 'c', category: 'D', tags: [] })
    await patchArticle(oldSlug, { status: 'published' })

    // Comments land in stage B; insert directly against the article_id FK so this
    // proves the *relationship*, not a write endpoint that does not exist yet.
    const articleId = await articleIdBySlug(oldSlug)
    expect(articleId).not.toBeNull()
    await app.db.query(
      `insert into comments (article_id, user_id, content) values ($1, $2, $3)`,
      [articleId, users.plain, 'a comment pinned by foreign key'],
    )

    // Baseline: the comment is reachable under the original slug.
    const before = await getJson<CommentList>(`/api/v1/articles/${oldSlug}/comments`)
    expect(before.status).toBe(200)
    expect(before.body.data).toHaveLength(1)

    // Rename.
    const renamed = await patchArticle(oldSlug, { slug: newSlugValue })
    expect(renamed.statusCode).toBe(200)
    expect((renamed.json() as ArticleAdmin).slug).toBe(newSlugValue)

    // The old slug no longer resolves — detail and comments both 404. Without
    // these two the rename proof is incomplete: a *copy* instead of a move would
    // leave the old row serving its own (comment-less) page, every assertion
    // below still passes, and the test would green-light the wrong behaviour.
    expect((await getJson(`/api/v1/articles/${oldSlug}`)).status).toBe(404)
    expect((await getJson(`/api/v1/articles/${oldSlug}/comments`)).status).toBe(404)

    // The new slug resolves.
    expect((await getJson(`/api/v1/articles/${newSlugValue}`)).status).toBe(200)

    // ...and the comment follows the article under the NEW slug.
    // This is the load-bearing assertion: under the old text-based association
    // (article_slug) the same rename silently orphans the comment and this
    // returns an empty list. We keep the FK, so it must still be here.
    const after = await getJson<CommentList>(`/api/v1/articles/${newSlugValue}/comments`)
    expect(after.status).toBe(200)
    expect(after.body.data).toHaveLength(1)
    expect(after.body.data[0]?.content).toBe('a comment pinned by foreign key')
  })
})

describe('concurrent same-slug create (S3-R3)', () => {
  it('lets exactly one insert succeed and returns SLUG_CONFLICT for the loser, leaking no SQLSTATE', async () => {
    const value = newSlug('race')
    const body = { slug: value, title: 'Racer', excerpt: 'e', content: 'c', category: 'D', tags: [] }

    const [a, b] = await Promise.all([postArticle(body), postArticle(body)])
    const results = [a, b]

    const created = results.filter((r) => r.statusCode === 201)
    const conflicted = results.filter((r) => r.statusCode === 409)

    expect(created).toHaveLength(1)
    expect(conflicted).toHaveLength(1)

    const loser = conflicted[0]!
    expect(loser.json().error.code).toBe(ERROR_CODES.slugConflict)
    // The raw Postgres unique-violation code must never reach the wire (design §1.2).
    expect(loser.body).not.toContain('23505')
    for (const r of results) expect(r.body).not.toContain('23505')
  })
})

describe('concurrent same-slug rename (S3-R3)', () => {
  it('lets exactly one rename win and returns SLUG_CONFLICT for the loser, leaking no SQLSTATE', async () => {
    // Creation conflicts go through `on conflict do nothing`; rename conflicts
    // go through the `23505` catch in `updateBySlug` — a different code path with
    // the same promise, so it needs its own test. Two live articles, two PATCHes
    // racing both target slugs onto one new slug: the unique index serialises
    // them, so exactly one UPDATE lands and the other is translated to 409.
    const first = newSlug('rename-a')
    const second = newSlug('rename-b')
    const target = newSlug('rename-target')
    const body = { title: 'R', excerpt: 'e', content: 'c', category: 'D', tags: [] }
    await postArticle({ slug: first, ...body })
    await postArticle({ slug: second, ...body })

    const [a, b] = await Promise.all([
      patchArticle(first, { slug: target }),
      patchArticle(second, { slug: target }),
    ])
    const results = [a, b]

    const won = results.filter((r) => r.statusCode === 200)
    const conflicted = results.filter((r) => r.statusCode === 409)
    expect(won).toHaveLength(1)
    expect(conflicted).toHaveLength(1)
    expect((won[0]!.json() as ArticleAdmin).slug).toBe(target)

    const loser = conflicted[0]!
    expect(loser.json().error.code).toBe(ERROR_CODES.slugConflict)
    for (const r of results) expect(r.body).not.toContain('23505')

    // The loser's article must still exist under its ORIGINAL slug — a failed
    // rename changes nothing; there is no half-applied state to clean up.
    // Checked through the FK helper rather than the public detail: these rows are
    // drafts, and the public endpoint answers 404 for drafts by design.
    // If `a` lost, the loser request renamed `first`, so `first` is intact.
    const survivorId = await articleIdBySlug(loser === a ? first : second)
    expect(survivorId).not.toBeNull()
  })
})

describe('first-publish stamp survives a stale read (design §1.1, race-free)', () => {
  it('a candidate timestamp from a stale reader cannot overwrite an existing published_at', async () => {
    // The deterministic shape of the concurrent double-publish: a reader saw the
    // row while `published_at` was null, then the row got published underneath it,
    // and the reader now submits its patch carrying a *later* candidate. Deciding
    // "first publish?" at read time and assigning plainly would land the stale
    // candidate and destroy the real first-publish time. `coalesce` under the row
    // lock keeps the earlier stamp — and unlike an HTTP-level race, fixed dates
    // make this fail reproducibly if the coalesce is removed.
    const value = newSlug('stale-stamp')
    const repo = new ArticleRepository(app.db)

    const created = await repo.insertDraft({
      slug: value,
      title: 'S',
      excerpt: 'e',
      contentMd: 'c',
      category: 'D',
      tags: [],
      coverImage: null,
      readTime: 5,
    })
    expect(created).not.toBeNull()

    const tFirst = new Date('2026-01-01T00:00:00.000Z')
    const tStale = new Date('2026-06-01T00:00:00.000Z')

    const first = await repo.updateBySlug(value, { status: 'published', publishedAt: tFirst })
    expect(first.kind).toBe('updated')

    const stale = await repo.updateBySlug(value, { status: 'published', publishedAt: tStale })
    expect(stale.kind).toBe('updated')

    if (stale.kind !== 'updated') throw new Error('unreachable: narrowed above')
    // Compare against the DB, not just the response echo: the response is read
    // back from the same statement, so a plain assertion on it is weaker than
    // re-reading the row that two racing writers fought over.
    const reread = await repo.findBySlug(value)
    expect(reread?.publishedAt).toBe(tFirst.toISOString())
  })
})

describe('DELETE /api/v1/articles/:slug', () => {
  it('answers 404 ARTICLE_NOT_FOUND for an unknown slug', async () => {
    const response = await deleteArticle(slug('never-existed'))
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe(ERROR_CODES.articleNotFound)
  })

  it('deleting twice answers 404 the second time, never confirming prior existence', async () => {
    // Same 404 whether "never there" or "already gone" — the endpoint gives no
    // oracle for whether a slug existed a moment ago.
    const value = newSlug('double-delete')
    await postArticle({ slug: value, title: 'D', excerpt: 'e', content: 'c', category: 'D', tags: [] })

    expect((await deleteArticle(value)).statusCode).toBe(204)
    const second = await deleteArticle(value)
    expect(second.statusCode).toBe(404)
    expect(second.json().error.code).toBe(ERROR_CODES.articleNotFound)
  })
})

describe('write endpoints authorisation — reverse tests (closes S2 gap)', () => {
  /**
   * Every case here now aims at a row that exists (or, for POST, at a slug that must
   * stay free) — and says so in its title with "and writes nothing".
   *
   * The previous version pointed PATCH and DELETE at `slug('authz')`, a row that was
   * never in the table, so all it could observe was the answer the endpoint gave. A
   * guard raised *after* the UPDATE/DELETE ran would still have answered 403 with the
   * right `error.code`, on a table it had just damaged, and passed. Status assertions
   * cannot see that; the bracketed row read can.
   */
  const methods: WriteRefusal[] = [
    {
      name: 'POST',
      // A POST's "before" state is the absence of a row, so there is nothing to
      // prepare — and the row it must not create is named here, so were the guard
      // ever to fail open the inserted row still sits inside `afterAll`'s sweep
      // instead of poisoning the seed baseline later count assertions read.
      prepare: async () => {},
      run: (value, headers) => postArticle({ slug: value, ...fixture }, headers),
      guard: async (value) => {
        const before = await articleCount()
        return async () => {
          expect(await articleCount(), `a refused POST still inserted ${value}`).toBe(before)
          expect(await storedArticle(value), `a refused POST still created ${value}`).toBeNull()
        }
      },
    },
    {
      name: 'PATCH',
      prepare: createTarget,
      run: (value, headers) => patchArticle(value, { title: 'Rewritten by a refused call' }, headers),
      guard: (value) => rowUntouched(value, 'a refused PATCH still rewrote the row'),
    },
    {
      name: 'DELETE',
      prepare: createTarget,
      run: (value, headers) => deleteArticle(value, headers),
      guard: (value) => rowUntouched(value, 'a refused DELETE still removed the row'),
    },
  ]

  for (const { name, prepare, run, guard } of methods) {
    it(`${name} without any credentials is 401 and writes nothing`, async () => {
      // 401 rather than 403: `requireAdmin` awaits the auth check inside itself, so
      // an unauthenticated admin write fails on *who you are* before the role is
      // ever consulted.
      const value = ownTarget(name, 'no-credentials')
      await prepare(value)
      const check = await guard(value)

      const response = await run(value, {})

      expect(response.statusCode).toBe(401)
      expect(response.json().error.code).toBe(ERROR_CODES.unauthorized)
      await check()
    })
  }

  for (const { name, prepare, run, guard } of methods) {
    it(`${name} as an authenticated non-admin is 403 and writes nothing`, async () => {
      const value = ownTarget(name, 'non-admin')
      await prepare(value)
      const check = await guard(value)

      const headers = { authorization: `Bearer ${tokenFor(users.plain)}`, 'x-requested-with': 'portal' }
      const response = await run(value, headers)

      expect(response.statusCode).toBe(403)
      expect(response.json().error.code).toBe(ERROR_CODES.forbidden)
      await check()
    })
  }

  for (const { name, prepare, run, guard } of methods) {
    it(`${name} as an admin missing the CSRF header is 403 CSRF_CHECK_FAILED and writes nothing`, async () => {
      // Admin is authorised, but the header is the last line — and it is enforced
      // on all three verbs, not only POST (design §5's named trap).
      const value = ownTarget(name, 'missing-csrf')
      await prepare(value)
      const check = await guard(value)

      const headers = { authorization: `Bearer ${tokenFor(users.admin)}` }
      const response = await run(value, headers)

      expect(response.statusCode).toBe(403)
      expect(response.json().error.code).toBe(ERROR_CODES.csrfCheckFailed)
      await check()
    })
  }
})

describe('structural guard: write SQL lives only in the repository', () => {
  it('the insert/update/delete statements appear in no layer but repository.ts', async () => {
    // Layering rule (architecture §1): routes and services must not speak SQL.
    // This is a real end-to-end guard that a grep can settle — but a zero-match
    // search is indistinguishable from a search that looked at nothing, so the
    // same pathspec is used to prove it does find repository.ts (control below).
    let out: string
    try {
      out = execFileSync(
        'git',
        [
          'grep',
          '-l',
          '-E',
          'insert into articles|update articles|delete from articles',
          '--',
          // `:/` anchors at the repo root; a bare path resolves against the
          // vitest cwd (apps/api) and would scan apps/api/apps/api/src — empty.
          ':/apps/api/src/modules/articles',
        ],
        { encoding: 'utf8', cwd: process.cwd() },
      )
    } catch (error) {
      // exit 1 == no matches. That is the failure case here (repository.ts must
      // match), so surface it as an error rather than letting emptiness pass.
      const { status, stderr } = error as { status?: number; stderr?: string }
      if (status !== 1) throw new Error(`git grep could not run (status ${status}): ${stderr ?? ''}`, { cause: error })
      out = ''
    }

    const files = out
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)

    // Guard: nothing outside the repository carries write SQL.
    expect(files.every((f) => f.endsWith('repository.ts'))).toBe(true)
    // Control: the pathspec really scanned something. Without this, a broken
    // pathspec (e.g. scanning a nonexistent dir) yields an empty list and the
    // assertion above passes vacuously.
    expect(files.length, 'pathspec matched no file; the guard above is vacuous').toBeGreaterThan(0)
  })
})
