import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import {
  ERROR_CODES,
  type AdminArticlePage,
  type AdminArticleSummary,
  type ArticleAdmin,
  type ArticlePage,
} from 'shared'
import { buildApp } from '../app.js'
import { loadConfig } from '../config/index.js'
import { generateJti } from '../lib/tokens.js'
import { decodeCursor } from '../lib/pagination.js'
import { waitForRedis } from './wait-for-redis.js'

/**
 * Admin reads (S3 stage D0 — S3-R20 / S3-R21, design §1.4).
 *
 * Real Fastify + real Postgres + real Redis: `requireAdmin` consults
 * `users.is_admin` and the token denylist, and the properties actually under test
 * here are about rows and order — which drafts a page contains, which row lands
 * first after an edit, whether a page boundary repeats a row. None of those can be
 * observed against a stand-in.
 *
 * The shape these tests are written to defend is the one the prd records as the
 * gap: a draft could be created, patched and deleted but never read back, so the
 * editor loaded it from the public endpoint, got a 404, and rendered an empty
 * new-article form — after which saving produced a duplicate or a slug conflict.
 * "The round trip" below is that scenario, and it is the only test here that would
 * have failed before this stage existed.
 */
let app: FastifyInstance
const config = loadConfig()

const users: { admin: string; plain: string } = { admin: '', plain: '' }

/** Unique per run: slugs and logins never collide with another run's rows. */
const run = randomUUID().slice(0, 8)
const PREFIX = `ad-${run}-`
const slugOf = (name: string): string => `${PREFIX}${name}`

/** Every fixture here carries this category, which makes one assertion exact. */
const CATEGORY = 'AdminReads'

/**
 * The seed's seven articles, used by the page walk below.
 *
 * They are the hardest part of this list to page through: all seven were inserted
 * by one `seed.ts` statement, so they share `updated_at` down to the microsecond —
 * measured, not assumed: `min(updated_at)` equals `max(updated_at)`
 * (`2026-09-28T11:24:00.908386Z`) over the seeded table. Inside a tie group of
 * seven, the `id desc` half of the cursor is the only thing keeping the walk from
 * repeating or dropping rows at `limit=2` — precisely where a timestamp-only bound
 * fails. Same list `articles.test.ts` walks for the public endpoint.
 */
const SEEDED_SLUGS = [
  'backslashes',
  'cjk-emoji',
  'dollar-tags',
  'draft-unpublished',
  'hostile-quotes',
  'normal-published',
  'oversized',
]

// Recorded up front (before the create can fail) so afterAll removes exactly these
// rows however a test died. The prefix sweep in afterAll covers a crashed run.
const createdSlugs: string[] = []
function newSlug(name: string): string {
  const value = slugOf(name)
  createdSlugs.push(value)
  return value
}

function tokenFor(userId: string): string {
  return app.signAccessToken({ sub: userId, jti: generateJti() })
}

/**
 * Admin bearer and nothing else.
 *
 * Deliberately *without* `x-requested-with`: these two endpoints take no CSRF
 * header, and the admin-gets-200 case below is what proves the guard list stayed
 * `[requireAdmin]` rather than being copy-pasted from the write routes.
 */
function adminAuth(): Record<string, string> {
  return { authorization: `Bearer ${tokenFor(users.admin)}` }
}

/** Fixtures still have to *create* rows, and writes do require the CSRF header. */
function adminWriteHeaders(): Record<string, string> {
  return { ...adminAuth(), 'x-requested-with': 'portal' }
}

async function getAdminList(query = ''): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url: `/api/v1/admin/articles${query}`, headers: adminAuth() })
}

async function getAdminDetail(
  value: string,
  headers: Record<string, string> = adminAuth(),
): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url: `/api/v1/admin/articles/${value}`, headers })
}

async function createArticle(value: string, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/articles',
    headers: adminWriteHeaders(),
    payload: {
      slug: value,
      title: `Title for ${value}`,
      excerpt: 'excerpt',
      content: 'body',
      category: CATEGORY,
      tags: ['admin-read'],
      ...extra,
    },
  })
}

function patchArticle(value: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/articles/${value}`,
    headers: adminWriteHeaders(),
    payload: body,
  })
}

function publicList(query = '') {
  return app.inject({ method: 'GET', url: `/api/v1/articles${query}` })
}

function adminPage(response: LightMyRequestResponse): AdminArticlePage {
  expect(response.statusCode).toBe(200)
  return response.json() as AdminArticlePage
}

function rowFor(page: AdminArticlePage, value: string): AdminArticleSummary | undefined {
  return page.data.find((row) => row.slug === value)
}

beforeAll(async () => {
  if (process.env.DATABASE_URL === undefined || process.env.REDIS_URL === undefined) {
    throw new Error('DATABASE_URL and REDIS_URL are required for admin article read tests')
  }

  app = await buildApp({ config })
  await waitForRedis(app)

  const inserted = await app.db.query<{ id: string; github_login: string }>(
    `insert into users (github_login, display_name, is_admin)
       values ($1, 'AD Admin', true), ($2, 'AD Plain', false)
       returning id, github_login`,
    [`ad-admin-${run}`, `ad-plain-${run}`],
  )
  for (const row of inserted.rows) {
    if (row.github_login === `ad-admin-${run}`) users.admin = row.id
    else users.plain = row.id
  }
})

afterAll(async () => {
  // In afterAll, not at the end of a test body: a failed assertion mid-test would
  // otherwise leave these rows behind to poison the next run.
  if (app?.db) {
    for (const value of createdSlugs) {
      await app.db.query(`delete from articles where slug = $1`, [value])
    }
    // Belt against a run that crashed before the loop above could see the slug.
    // Keyed on the login/slug prefix, not an id, so an empty id from a failed
    // beforeAll cannot throw on a uuid cast and mask the real error.
    await app.db.query(`delete from articles where slug like $1`, [`${PREFIX}%`])
    await app.db.query(`delete from users where github_login like 'ad-%'`)
  }
  await app?.close()
})

describe('GET /api/v1/admin/articles — visibility', () => {
  it('serves draft, published and archived rows to an admin while the public list keeps serving only published', async () => {
    const draft = newSlug('cmp-draft')
    const published = newSlug('cmp-published')
    const archived = newSlug('cmp-archived')

    expect((await createArticle(draft)).statusCode).toBe(201)
    expect((await createArticle(published)).statusCode).toBe(201)
    expect((await createArticle(archived)).statusCode).toBe(201)
    expect((await patchArticle(published, { status: 'published' })).statusCode).toBe(200)
    expect((await patchArticle(archived, { status: 'published' })).statusCode).toBe(200)
    expect((await patchArticle(archived, { status: 'archived' })).statusCode).toBe(200)

    // Both endpoints, one run, the same three rows. The pair *is* the test: an
    // assertion that only the admin list contains a draft would also pass with the
    // visibility rule deleted outright, because `status = 'published'` living in
    // `listPublished` is what keeps the public one honest and nothing here checks
    // it from the admin side.
    const admin = adminPage(await getAdminList('?limit=50'))
    expect(rowFor(admin, draft)?.status).toBe('draft')
    expect(rowFor(admin, published)?.status).toBe('published')
    expect(rowFor(admin, archived)?.status).toBe('archived')

    // `publishedAt` is nullable on this surface — a draft has never been published
    // — where the public summary type declares it required. Fabricating a date to
    // fit that shape was the failure mode the schema comment warns about.
    expect(rowFor(admin, draft)?.publishedAt).toBeNull()
    expect(rowFor(admin, published)?.publishedAt).not.toBeNull()
    // Archiving keeps the first-publish time (design §1.1), so an archived row shows
    // one too. The admin list is allowed to say so; the public list cannot serve it.
    expect(rowFor(admin, archived)?.publishedAt).not.toBeNull()

    const publicRes = await publicList(`?limit=50&category=${CATEGORY}`)
    expect(publicRes.statusCode).toBe(200)
    const pub = publicRes.json() as ArticlePage
    // Exact equality, not membership: every row in this category was made above, so
    // "only the published one is public" is provable here rather than hinted at.
    expect(pub.data.map((row) => row.slug)).toEqual([published])
  })

  it('carries status and updatedAt on every row and no article body on any of them', async () => {
    const value = newSlug('shape-draft')
    await createArticle(value, { content: 'a body far too large to ship in a list' })

    const page = adminPage(await getAdminList('?limit=50'))
    const row = rowFor(page, value)
    expect(row).toBeDefined()

    // An exact key set, so an extra `content` cannot ride along unnoticed. The
    // repository never selects `content_md` for this projection, but the response
    // shape is what a client actually depends on, so that is what gets asserted.
    expect(Object.keys(row!).sort()).toEqual(
      [
        'slug',
        'title',
        'excerpt',
        'category',
        'tags',
        'coverImage',
        'readTime',
        'publishedAt',
        'status',
        'updatedAt',
      ].sort(),
    )
    expect('content' in row!).toBe(false)
    // For every row, not just the fixture's own: the seed's published articles are
    // in this same page, and a body leaking into the list would be a leak on those
    // rows too — including the largest one, `oversized` (117 KiB of markdown).
    for (const r of page.data) expect('content' in r).toBe(false)
  })

  it('narrows to one status when asked, and refuses one the schema does not know', async () => {
    const onlyDraft = newSlug('filter-draft')
    await createArticle(onlyDraft)

    const drafts = adminPage(await getAdminList('?limit=50&status=draft'))
    expect(drafts.data.length).toBeGreaterThan(0)
    expect(drafts.data.every((row) => row.status === 'draft')).toBe(true)
    expect(rowFor(drafts, onlyDraft)).toBeDefined()

    const published = adminPage(await getAdminList('?limit=50&status=published'))
    expect(published.data.every((row) => row.status === 'published')).toBe(true)
    expect(rowFor(published, onlyDraft)).toBeUndefined()

    // An unknown status must be answered by the DTO. What it must not become is a
    // predicate that reaches Postgres: `status = 'Archived'` breaks no constraint
    // (constraints bind writes, not reads), so it would come back as a 200 with an
    // empty page — indistinguishable from "you have no archived articles". Verified
    // by swapping the enum for `z.string()`: this loop is the only thing that goes
    // red, and it goes red on a 200.
    for (const bad of ['not-a-status', 'PUBLISHED', 'draft; drop table articles']) {
      const res = await getAdminList(`?status=${encodeURIComponent(bad)}`)
      expect(res.statusCode, bad).toBe(400)
      expect(res.json().error.code, bad).toBe(ERROR_CODES.badRequest)
      // Conventions §2's leak check, kept even though the failure mode above is a
      // quiet zero rather than a driver error: if the predicate ever does climb into
      // SQL, a SQLSTATE or a constraint name on the wire is the tell.
      expect(res.body, bad).not.toContain('23514')
      expect(res.body, bad).not.toContain('check_constraint')
      expect(res.body, bad).not.toContain('FST_ERR')
      // Nothing that looks like a query may appear: the rejected value is answered
      // by the validator and never reaches a statement, so the response can say
      // nothing about the SQL it did not run.
      expect(res.body, bad).not.toContain('from articles')
    }
  })

  it('bounds limit the same way the public list does', async () => {
    // The ceiling is a control on how many rows one request may read; there is no
    // reason the admin surface gets the looser one.
    for (const raw of ['0', '-3', 'abc', '51', '1.5']) {
      const res = await getAdminList(`?limit=${raw}`)
      expect(res.statusCode, raw).toBe(400)
      expect(res.json().error.code, raw).toBe(ERROR_CODES.badRequest)
      expect(res.body, raw).not.toContain('FST_ERR')
    }
  })
})

describe('GET /api/v1/admin/articles — ordering (design §1.4)', () => {
  it('moves an article to the first row of the first page the moment it is edited', async () => {
    const older = newSlug('order-older')
    const newer = newSlug('order-newer')
    expect((await createArticle(older)).statusCode).toBe(201)
    expect((await createArticle(newer)).statusCode).toBe(201)

    // Baseline: last write wins.
    expect(adminPage(await getAdminList('?limit=5')).data[0]?.slug).toBe(newer)

    // Editing the older one must put it at the top. Neither `created_at` nor
    // `published_at` moves when a row is edited, so an order built on either cannot
    // produce this result — which is exactly the mistake design §1.4 calls out:
    // under the public list's `published_at desc nulls last` every draft shares one
    // NULL sort key and edits change nothing about its position.
    expect((await patchArticle(older, { title: 'Edited just now' })).statusCode).toBe(200)

    const after = adminPage(await getAdminList('?limit=5'))
    expect(after.data[0]?.slug).toBe(older)
    expect(after.data[0]?.title).toBe('Edited just now')
  })

  it('orders drafts among themselves by update time instead of piling them behind published rows', async () => {
    const pub = newSlug('ord-published')
    const firstDraft = newSlug('ord-first')
    const lastDraft = newSlug('ord-last')

    await createArticle(pub)
    expect((await patchArticle(pub, { status: 'published' })).statusCode).toBe(200)
    await createArticle(firstDraft)
    await createArticle(lastDraft)

    const page = adminPage(await getAdminList('?limit=50'))

    // Scoped to this run's rows: the seed's seven articles and any residue from
    // another suite sit further down the same order and would make an absolute
    // index fragile for reasons that have nothing to do with this assertion.
    const mine = page.data.filter((row) => row.slug.startsWith(PREFIX)).map((row) => row.slug)

    // Reachable only through `order by updated_at desc`. Under the public list's
    // `published_at desc nulls last`, `pub` leads and the two drafts follow in uuid
    // order — a coin flip, so the assertion below is not something a wrong
    // implementation can pass by luck.
    expect(mine.slice(0, 3)).toEqual([lastDraft, firstDraft, pub])

    // The whole page, not just my rows: `updated_at` must be non-increasing
    // top-to-bottom. This is the property `id desc` alone cannot fake.
    const times = page.data.map((row) => Date.parse(row.updatedAt))
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })
})

describe('GET /api/v1/admin/articles — keyset pagination', () => {
  it('walks every page with no article repeated and none skipped', async () => {
    // Three articles created *now* are the newest three rows in the table, so the
    // first two pages are exactly predictable. Nothing is compared against
    // `count(*)`: the local database carries seed rows and other suites write too.
    const a = newSlug('page-a')
    const b = newSlug('page-b')
    const c = newSlug('page-c')
    for (const value of [a, b, c]) expect((await createArticle(value)).statusCode).toBe(201)

    const page1 = adminPage(await getAdminList('?limit=2'))
    expect(page1.data.map((row) => row.slug)).toEqual([c, b])
    expect(page1.next).not.toBeNull()
    expect(page1.limit).toBe(2)

    const page2 = adminPage(await getAdminList(`?limit=2&cursor=${page1.next!.cursor}`))
    expect(page2.data[0]?.slug).toBe(a)
    // The boundary itself: page 2 must not re-serve anything page 1 already did.
    expect(
      page2.data.some((row) => page1.data.some((p1) => p1.slug === row.slug)),
    ).toBe(false)

    // Then the full walk to exhaustion. This is the only assertion here that covers
    // the tie group: the seven seeded rows share one `updated_at`, so paging across
    // them works only if the cursor carries the `id desc` tie-breaker as well.
    const seen: string[] = []
    let cursor: string | undefined
    let finished = false

    for (let n = 0; n < 40; n += 1) {
      const res = await getAdminList(`?limit=2${cursor === undefined ? '' : `&cursor=${cursor}`}`)
      expect(res.statusCode, `page ${n}`).toBe(200)
      const body = res.json() as AdminArticlePage
      expect(body.data.length, `page ${n}`).toBeLessThanOrEqual(2)
      for (const row of body.data) seen.push(row.slug)

      if (body.next === null) {
        finished = true
        break
      }
      cursor = body.next.cursor
    }

    expect(finished, 'the page walk never terminated').toBe(true)
    expect(new Set(seen).size, 'a row appeared on two pages').toBe(seen.length)
    for (const value of createdSlugs) {
      expect(seen, `missing ${value} after the page walk`).toContain(value)
    }
    // Exactly once each, inside the tie group — "appears somewhere in `seen`" would
    // still allow a row served on two consecutive pages.
    for (const seeded of SEEDED_SLUGS) {
      expect(seen.filter((s) => s === seeded), `seed row ${seeded}`).toHaveLength(1)
    }
  })

  it('cursors on the microsecond timestamp, not the millisecond value the client was sent', async () => {
    const page = adminPage(await getAdminList('?limit=2'))
    expect(page.next).not.toBeNull()
    const last = page.data.at(-1)
    expect(last).toBeDefined()

    const cursor = decodeCursor(page.next!.cursor)
    // `updatedAt` on the wire is ISO with milliseconds because that is what a client
    // renders; `to_char(..., '...US...')` in the projection is microseconds, because
    // Postgres stores them. Feeding the lossy one back as the bound can truncate it
    // below the row it came from and repeat that row on the next page.
    expect(last!.updatedAt).toMatch(/\.\d{3}Z$/)
    expect(cursor.p).toMatch(/\.\d{6}Z$/)
    // Same instant, two precisions: the cursor is the row's key, not a new one.
    expect(Date.parse(cursor.p)).toBe(Date.parse(last!.updatedAt))
  })

  it('rejects a tampered cursor as INVALID_CURSOR, not a 500', async () => {
    const res = await getAdminList('?cursor=not-a-real-cursor')
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe(ERROR_CODES.invalidCursor)
  })
})

describe('GET /api/v1/admin/articles/:slug', () => {
  it('reads a draft back with its body and status while the public detail still 404s the same slug', async () => {
    const value = newSlug('detail-draft')
    const created = (await createArticle(value, {
      content: 'the body an admin must be able to re-read',
    })).json() as ArticleAdmin
    expect(created.status).toBe('draft')

    const res = await getAdminDetail(value)
    expect(res.statusCode).toBe(200)
    const draft = res.json() as ArticleAdmin
    expect(draft.slug).toBe(value)
    expect(draft.status).toBe('draft')
    expect(draft.publishedAt).toBeNull()
    expect(draft.content).toBe('the body an admin must be able to re-read')
    // The detail response is the same shape the write path returns, so the editor
    // needs no second type to load what it just saved.
    expect(draft.updatedAt).toBe(created.updatedAt)

    // Same run, same slug, public endpoint: the answer did not change. This is the
    // half that makes the pair above a test rather than a demo — an admin door that
    // also widened the public one would still pass every other assertion here.
    const publicDetail = await app.inject({ method: 'GET', url: `/api/v1/articles/${value}` })
    expect(publicDetail.statusCode).toBe(404)
    expect(publicDetail.json().error.code).toBe(ERROR_CODES.articleNotFound)
  })

  it('reads an archived article, a status no public surface can express', async () => {
    const value = newSlug('detail-archived')
    await createArticle(value)
    expect((await patchArticle(value, { status: 'published' })).statusCode).toBe(200)
    expect((await patchArticle(value, { status: 'archived' })).statusCode).toBe(200)

    const res = await getAdminDetail(value)
    expect(res.statusCode).toBe(200)
    const archived = res.json() as ArticleAdmin
    expect(archived.status).toBe('archived')
    expect(archived.publishedAt).not.toBeNull()
  })

  it('completes the round trip whose absence made a saved draft unreadable', async () => {
    // The prd's recorded consequence of the missing read endpoint, stated as
    // behaviour: with only the public detail to load from, a draft 404'd, the page
    // looked like a blank new-article form, and saving produced a slug conflict.
    const value = newSlug('round-trip')
    await createArticle(value, { title: 'Before' })

    const loaded = (await getAdminDetail(value)).json() as ArticleAdmin
    expect(loaded.title).toBe('Before')

    // Re-creating it is refused — so the read endpoint is the only way back to the
    // row, which is the point.
    expect((await createArticle(value, { title: 'Again' })).statusCode).toBe(409)

    expect((await patchArticle(value, { title: 'After' })).statusCode).toBe(200)
    const reread = (await getAdminDetail(value)).json() as ArticleAdmin
    expect(reread.title).toBe('After')
    expect(reread.slug).toBe(value)
    expect(reread.status).toBe('draft')
  })

  it('answers 404 ARTICLE_NOT_FOUND for a slug that matches no row', async () => {
    const res = await getAdminDetail(slugOf('never-existed'))
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe(ERROR_CODES.articleNotFound)
  })
})

describe('admin read authorisation — reverse tests', () => {
  const endpoints = [
    {
      name: 'list',
      call: (headers: Record<string, string>) =>
        app.inject({ method: 'GET', url: '/api/v1/admin/articles', headers }),
    },
    {
      name: 'detail',
      call: (headers: Record<string, string>) =>
        app.inject({ method: 'GET', url: `/api/v1/admin/articles/${slugOf('authz')}`, headers }),
    },
  ]

  for (const { name, call } of endpoints) {
    it(`${name} without any credentials is 401`, async () => {
      const res = await call({})
      expect(res.statusCode).toBe(401)
      expect(res.json().error.code).toBe(ERROR_CODES.unauthorized)
    })

    it(`${name} as a logged-in non-admin is 403`, async () => {
      const res = await call({ authorization: `Bearer ${tokenFor(users.plain)}` })
      expect(res.statusCode).toBe(403)
      expect(res.json().error.code).toBe(ERROR_CODES.forbidden)
    })

    /**
     * The guard-order proof. These routes carry only `requireAdmin`, so the one way
     * to get this wrong in the direction that matters is to let the CSRF header
     * stand in for authorisation ("has the header ⇒ allowed"). A non-admin holding
     * the header must still be refused — and refused with `FORBIDDEN`, not a code
     * that implies the header was what got consulted.
     */
    it(`${name} as a non-admin carrying the CSRF header is still 403 FORBIDDEN`, async () => {
      const res = await call({
        authorization: `Bearer ${tokenFor(users.plain)}`,
        'x-requested-with': 'portal',
      })
      expect(res.statusCode).toBe(403)
      expect(res.json().error.code).toBe(ERROR_CODES.forbidden)
      expect(res.body).not.toContain(ERROR_CODES.csrfCheckFailed)
    })
  }

  it('serves the list to an admin with no CSRF header at all', async () => {
    // The writes answer 403 CSRF_CHECK_FAILED without this header (asserted in
    // articles-write.test.ts). A read must not — otherwise adding the hook to a GET
    // would look harmless until a browser preflight or a hand-typed URL failed on
    // an already-authorised admin.
    const res = await getAdminList('?limit=1')
    expect(res.statusCode).toBe(200)
  })

  it('leaks nothing about a draft through the unauthenticated path', async () => {
    const value = newSlug('leak-draft')
    await createArticle(value, { title: 'Unannounced draft' })

    const res = await app.inject({ method: 'GET', url: `/api/v1/admin/articles/${value}` })
    expect(res.statusCode).toBe(401)
    // A refusal must not turn into an echo of what the caller is not allowed to see.
    expect(res.body).not.toContain('Unannounced draft')
    expect(res.body).not.toContain(value)
  })
})

/**
 * Runs `git grep -n -E <pattern>` over the articles module and returns the raw
 * `file:line:text` matches, '' for "no matches".
 *
 * `:/` anchors the pathspec at the repo root: a bare path resolves against the
 * vitest cwd (`apps/api`) and would scan `apps/api/apps/api/src` — an empty
 * directory, which is exactly the silently-vacuous scan this helper exists to
 * avoid.
 */
function gitGrepArticlesModule(pattern: string): string {
  try {
    return execFileSync(
      'git',
      ['grep', '-n', '-E', pattern, '--', ':/apps/api/src/modules/articles'],
      { encoding: 'utf8', cwd: process.cwd() },
    )
  } catch (error) {
    // exit 1 means "no matches". Here that is a finding, not an absence of one:
    // repository.ts is expected to match, so surface it as the empty list the
    // caller's control assertion will reject.
    const { status, stderr } = error as { status?: number; stderr?: string }
    if (status !== 1) {
      throw new Error(`git grep could not run (status ${status}): ${stderr ?? ''}`, {
        cause: error,
      })
    }
    return ''
  }
}

function matchedFiles(out: string): string[] {
  return out
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split(':')[0]!)
}

describe('structural guard: article SQL lives only in the repository', () => {
  it('no layer but repository.ts queries the articles table', async () => {
    // Layering rule (architecture §1): routes and services must not speak SQL, and
    // this stage adds the module's first read used by two different endpoints, so
    // there is now a plausible reason to "just" query from somewhere else.
    const files = matchedFiles(
      gitGrepArticlesModule(
        'from articles|insert into articles|update articles|delete from articles',
      ),
    )

    expect(files.every((f) => f.endsWith('repository.ts'))).toBe(true)
    // Control: the pathspec really scanned something. Without this, a broken search
    // yields an empty list and the assertion above passes vacuously.
    expect(files.length, 'pathspec matched no file; the guard above is vacuous').toBeGreaterThan(0)
  })

  it('polices the admin list statement rather than passing beside it', async () => {
    // The guard above cannot tell "the new statement is inside the policed file"
    // from "the new statement was never matched": `from articles` is satisfied by
    // the three pre-existing queries all by itself, so it would stay green if the
    // admin projection had landed in another layer under wording the pattern does
    // not catch. Searching for the projection by name and requiring it in
    // repository.ts is what makes the scan cover this stage's addition.
    const out = gitGrepArticlesModule('ADMIN_LIST_COLUMNS')
    const files = matchedFiles(out)

    expect(files.every((f) => f.endsWith('repository.ts'))).toBe(true)
    // Declaration *and* the statement that interpolates it. One match would mean
    // the columns are defined but no query uses them, i.e. this guard is not
    // actually looking at the admin list's SQL.
    expect(files.length, 'admin list projection found, but not in a statement').toBeGreaterThanOrEqual(2)
  })
})
