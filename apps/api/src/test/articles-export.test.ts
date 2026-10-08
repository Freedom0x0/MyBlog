import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import {
  ERROR_CODES,
  type AdminArticlePage,
  type ArticlePage,
  type ExportedBlog,
  type ImportArticleCreatedResult,
  type ImportArticlesResponse,
} from 'shared'
import { buildApp } from '../app.js'
import { loadConfig } from '../config/index.js'
import { generateJti } from '../lib/tokens.js'
import { FixtureError, parseFixture } from '../db/frontmatter.js'
import {
  CreateArticleSchema,
  IMPORT_MAX_MARKDOWN_BYTES,
  ImportArticleFileSchema,
} from '../modules/articles/schema.js'
import type { ArticleRecord } from '../modules/articles/repository.js'
import { buildExportFilename, renderArticleMarkdown } from '../modules/articles/service.js'
import { waitForRedis } from './wait-for-redis.js'

/**
 * The way out (S8-a, `GET /api/v1/admin/articles/export`).
 *
 * Real Fastify + real Postgres + real Redis again, for the same reason the import
 * suite is: the property under test is "the file this endpoint produces can put the
 * article back into the table", and that is a statement about rows. A shape check
 * would pass on an export whose markdown the parser rejects — which is precisely the
 * defect class this endpoint exists to close. A backup nobody can restore is not a
 * backup, it is a false sense of one.
 *
 * Three claims get the most scrutiny here, because all three are easy to write in a
 * way that asserts nothing:
 * - "every status is exported" — proved by the seeded draft *and* a live archived row,
 *   with the public list and the admin `?status=published` filter shown refusing both.
 * - "the order is deterministic" — proved twice on purpose: once by exporting twice and
 *   comparing, once against an order computed from `fixtures/*.md` on disk. The first
 *   alone is weak (an unsorted read of a small table returns the same sequence twice in
 *   a row), and the second is what catches a missing or changed `ORDER BY`.
 * - "the export writes nothing" — proved by row identity including `views`, with a
 *   control that makes the counter it is measured with unable to pass vacuously.
 */
let app: FastifyInstance
const config = loadConfig()

const users: { admin: string; plain: string } = { admin: '', plain: '' }

/** Unique per run: slugs and logins never collide with another run's rows. */
const run = randomUUID().slice(0, 8)
const slugOf = (name: string): string => `ex-${run}-${name}`

/** Every slug this file creates, so afterAll can remove exactly these. */
const createdSlugs: string[] = []
function newSlug(name: string): string {
  const value = slugOf(name)
  createdSlugs.push(value)
  return value
}

/** The article the full delete → import → restore cycle runs against. */
const ROUND_TRIP_SLUG = 'backslashes'

/**
 * An article with no comments, used for "the export did not touch this row at all".
 * `normal-published` is the only seeded article carrying comments, so it is
 * deliberately NOT the one used here: rewriting it would drag the comment baseline
 * along and confound the residue check with a cascade.
 */
const UNTOUCHED_SLUG = 'cjk-emoji'

const CATEGORY = 'Exported'

function tokenFor(userId: string): string {
  return app.signAccessToken({ sub: userId, jti: generateJti() })
}

/** Admin bearer only — the export is a GET and must not need the CSRF header. */
function adminAuth(): Record<string, string> {
  return { authorization: `Bearer ${tokenFor(users.admin)}` }
}

/** Fixtures here still have to *create* rows, and writes do require the CSRF header. */
function adminWriteHeaders(): Record<string, string> {
  return { ...adminAuth(), 'x-requested-with': 'portal' }
}

async function exportRaw(
  headers: Record<string, string> = adminAuth(),
  url = '/api/v1/admin/articles/export',
): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url, headers })
}

async function exportDoc(): Promise<ExportedBlog> {
  const response = await exportRaw()
  expect(response.statusCode).toBe(200)
  return response.json() as ExportedBlog
}

/**
 * Total rows in `articles`, for the "nothing was written" proofs.
 *
 * Always compared against itself before/after — never against a magic number — because
 * what other suites leave behind must not be able to break the assertion. The control
 * inside the writes-nothing test is what keeps this honest: a counter that cannot see a
 * write cannot prove the absence of one either.
 */
async function articleCount(): Promise<number> {
  const { rows } = await app.db.query<{ n: number }>('select count(*)::int as n from articles')
  return rows[0]!.n
}

async function commentCount(): Promise<number> {
  const { rows } = await app.db.query<{ n: number }>('select count(*)::int as n from comments')
  return rows[0]!.n
}

async function slugsInTable(): Promise<string[]> {
  // Deliberately unordered: mirroring the export's `ORDER BY` here would turn the
  // ordering assertions below into a comparison of the query with itself.
  const { rows } = await app.db.query<{ slug: string }>('select slug from articles')
  return rows.map((row) => row.slug)
}

/**
 * A whole row as text, for exact snapshot / compare / restore.
 *
 * The timestamps go through `::text` rather than the driver's `Date`: Postgres stores
 * microseconds and `Date` holds milliseconds, so a JavaScript round trip would truncate
 * `updated_at` and the "this row is byte-identical to what it was" claim would fail for
 * a reason that has nothing to do with the code under test. Text out, text cast back in
 * at insert, exact both ways.
 */
interface RowSnapshot {
  id: string
  slug: string
  title: string
  excerpt: string
  content_md: string
  category: string
  tags: string[]
  cover_image: string | null
  read_time: number
  status: string
  views: number
  published_at: string | null
  created_at: string
  updated_at: string
}

async function snapshotRow(value: string): Promise<RowSnapshot> {
  const { rows } = await app.db.query<RowSnapshot>(
    `select id, slug, title, excerpt, content_md, category, tags, cover_image,
            read_time, status, views,
            published_at::text as published_at,
            created_at::text as created_at,
            updated_at::text as updated_at
       from articles where slug = $1`,
    [value],
  )

  const row = rows[0]
  // The same trap `storedRows([])` refuses to walk into in articles-import.test.ts:
  // comparing `null` with `null` passes, so a fixture row that was never there would
  // make every restore assertion downstream vacuously true.
  if (row === undefined) {
    throw new Error(`fixture row ${value} is missing; the snapshot would assert on nothing`)
  }
  return row
}

/** Put a snapshotted row back exactly as it was, id included so comments keep their FK. */
async function restoreRow(row: RowSnapshot): Promise<void> {
  await app.db.query(
    `insert into articles
       (id, slug, title, excerpt, content_md, category, tags, cover_image, read_time,
        status, views, published_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::timestamptz, $14::timestamptz)`,
    [
      row.id,
      row.slug,
      row.title,
      row.excerpt,
      row.content_md,
      row.category,
      row.tags,
      row.cover_image,
      row.read_time,
      row.status,
      row.views,
      row.published_at,
      row.created_at,
      row.updated_at,
    ],
  )
}

async function createArticle(value: string, title: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/articles',
    headers: adminWriteHeaders(),
    payload: {
      slug: value,
      title,
      excerpt: 'an excerpt for the export tests',
      content: `# ${title}\n\nbody written for the export tests`,
      category: CATEGORY,
      tags: ['export'],
    },
  })
  expect(response.statusCode).toBe(201)
}

async function setStatus(value: string, status: 'published' | 'archived'): Promise<void> {
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/v1/articles/${value}`,
    headers: adminWriteHeaders(),
    payload: { status },
  })
  expect(response.statusCode).toBe(200)
}

async function deleteRows(values: string[]): Promise<void> {
  for (const value of values) {
    await app.db.query(`delete from articles where slug = $1`, [value])
  }
}

/**
 * The seven seed fixtures as raw text, read exactly the way `seed.ts` reads them.
 *
 * These files are the oracle for the two strongest claims below — "the exported
 * markdown is byte-identical to what the owner keeps on disk" and "the entries come out
 * in `published_at desc nulls last, slug` order". Both are decided from data that did
 * not come from the query under test, which is the only way an `ORDER BY` mutation can
 * be caught at all.
 */
const FIXTURES_DIR = new URL('../../fixtures/', import.meta.url)

async function readFixtureFiles(): Promise<Map<string, string>> {
  const entries = (await readdir(FIXTURES_DIR)).filter((file) => file.endsWith('.md'))
  const pairs = await Promise.all(
    entries.map(async (file) => {
      const raw = await readFile(new URL(file, FIXTURES_DIR))
      return [file, raw.toString('utf8')] as const
    }),
  )
  return new Map(pairs)
}

/**
 * The order the export must produce: published rows newest-first, then everything that
 * was never published, in slug order — `published_at desc nulls last, slug` re-expressed
 * in TypeScript from the fixtures plus whatever slugs the caller says are also in the
 * table with no publication time.
 *
 * Two approximations, both safe here and worth naming rather than leaving implicit: the
 * fixture timestamps are all second-precision `…Z` strings, so comparing them as
 * strings is comparing them as instants; and every tie this test produces is between
 * lowercase-ASCII slugs, where Postgres's collation and JavaScript's code-unit ordering
 * agree. A tie between CJK and ASCII slugs would be the day this oracle needs the
 * database's collation instead.
 */
function expectedExportOrder(fixtureFiles: Map<string, string>, extraUnpublished: string[]): string[] {
  const entries: { slug: string; publishedAt: string | null }[] = []

  for (const raw of fixtureFiles.values()) {
    const fixture = parseFixture(raw, 'oracle')
    entries.push({ slug: fixture.slug, publishedAt: fixture.publishedAt })
  }
  for (const slug of extraUnpublished) {
    entries.push({ slug, publishedAt: null })
  }

  return entries
    .sort((a, b) => {
      if (a.publishedAt === null && b.publishedAt === null) {
        return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
      }
      if (a.publishedAt === null) return 1
      if (b.publishedAt === null) return -1
      return a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0
    })
    .map((entry) => entry.slug)
}

function entryFor(doc: ExportedBlog, slug: string): ExportedBlog['articles'][number] {
  const found = doc.articles.find((file) => file.name === `${slug}.md`)
  if (found === undefined) throw new Error(`${slug}.md is not in the export`)
  return found
}

function createdResult(response: LightMyRequestResponse, file: string): ImportArticleCreatedResult {
  const results = (response.json() as ImportArticlesResponse).results
  expect(results, `import of ${file} returned no results`).toHaveLength(1)
  const first = results[0]!
  // Not an assertion to read past: a conflict or a 4xx here means the export produced a
  // file the import will not take, which is the one finding this stage cannot allow.
  if (first.kind !== 'created') throw new Error(`expected ${file} to be created, got ${JSON.stringify(first)}`)
  return first
}

/** A synthetic row for the renderer's unit tests — nothing here touches the database. */
function record(overrides: Partial<ArticleRecord> = {}): ArticleRecord {
  return {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    slug: 'unit-render',
    title: 'Unit render',
    excerpt: 'an excerpt',
    category: 'Units',
    tags: ['alpha', 'beta'],
    coverImage: null,
    readTime: 7,
    publishedAt: '2026-09-20T10:00:00.000Z',
    status: 'published',
    contentMd: '# Body\n\ntext\n',
    updatedAt: '2026-09-28T11:24:00.908Z',
    ...overrides,
  }
}

/** Runs `git grep` over the articles module, as admin-articles.test.ts does. */
function gitGrepArticlesModule(pattern: string): string {
  try {
    return execFileSync('git', ['grep', '-n', '-E', pattern, '--', ':/apps/api/src/modules/articles'], {
      encoding: 'utf8',
      cwd: process.cwd(),
    })
  } catch (error) {
    // exit 1 means "no matches", which for these guards is a finding the caller's
    // assertion has to be able to reject — not an absence of one.
    const { status, stderr } = error as { status?: number; stderr?: string }
    if (status !== 1) {
      throw new Error(`git grep could not run (status ${status}): ${stderr ?? ''}`, { cause: error })
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

const fixtureFiles = await readFixtureFiles()
const seededSlugs = [...fixtureFiles.entries()].map(([file, raw]) => ({ file, slug: parseFixture(raw, file).slug }))

/** Captured before any test can move the table, for the residue check. */
let baselineArticles = 0
let baselineComments = 0
/** Captured before the round trip can delete it, so afterAll can always put it back. */
let roundTripBaseline: RowSnapshot | null = null

beforeAll(async () => {
  if (process.env.DATABASE_URL === undefined || process.env.REDIS_URL === undefined) {
    throw new Error('DATABASE_URL and REDIS_URL are required for article export tests')
  }

  // The byte-identity test below compares exported markdown with the files on disk. If
  // the working tree ever holds CRLF fixtures, the seed (which reads the same bytes)
  // and the export would still agree with each other and this test would fail for a
  // reason that is not the endpoint's — so name the broken premise instead.
  for (const [file, raw] of fixtureFiles) {
    if (raw.includes('\r\n')) {
      throw new Error(`fixtures/${file} has CRLF line endings; the export byte-identity test reads LF`)
    }
  }

  app = await buildApp({ config })
  await waitForRedis(app)

  const inserted = await app.db.query<{ id: string; github_login: string }>(
    `insert into users (github_login, display_name, is_admin)
       values ($1, 'EX Admin', true), ($2, 'EX Plain', false)
       returning id, github_login`,
    [`ex-admin-${run}`, `ex-plain-${run}`],
  )
  for (const row of inserted.rows) {
    if (row.github_login === `ex-admin-${run}`) users.admin = row.id
    else users.plain = row.id
  }

  baselineArticles = await articleCount()
  baselineComments = await commentCount()
  roundTripBaseline = await snapshotRow(ROUND_TRIP_SLUG)
})

afterAll(async () => {
  // In afterAll, not at the end of a test body: an assertion failing mid-test must
  // still not leave these rows behind to poison the next run — nor leave the seeded
  // article deleted, which would cost the suite its baseline.
  if (app?.db) {
    for (const value of createdSlugs) {
      await app.db.query(`delete from articles where slug = $1`, [value])
    }
    // Prefix sweep as the backstop for anything created before a test threw. No seed
    // fixture slug starts with `ex-`, so nothing outside this suite's naming matches.
    await app.db.query(`delete from articles where slug like $1`, [`ex-${run}-%`])
    await app.db.query(`delete from users where github_login like $1`, [`ex-%-${run}`])

    if (roundTripBaseline !== null) {
      const stillThere = await app.db.query(`select 1 from articles where slug = $1`, [ROUND_TRIP_SLUG])
      if (stillThere.rowCount === 0) await restoreRow(roundTripBaseline)
    }
  }
  await app?.close()
})

describe('GET /api/v1/admin/articles/export — the document', () => {
  it('answers 200 with version 1, an export time and one entry per row in the table', async () => {
    const response = await exportRaw()
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')

    const doc = response.json() as ExportedBlog
    expect(doc.version).toBe(1)
    expect(typeof doc.exportedAt).toBe('string')
    expect(Number.isNaN(Date.parse(doc.exportedAt))).toBe(false)

    // The coverage claim, and no other read endpoint can make it: the export's entries
    // are exactly the table's rows, published or not. A query that inherited the public
    // list's filter, or the admin list's default, is short here by precisely the drafts.
    expect(doc.articles.length).toBe(await articleCount())
    expect(new Set(doc.articles.map((file) => file.name))).toEqual(
      new Set((await slugsInTable()).map((slug) => `${slug}.md`)),
    )
    for (const { file, slug } of seededSlugs) {
      expect(entryFor(doc, slug), `fixtures/${file} is missing from the export`).toBeDefined()
    }

    // Names are bare labels, the way the import's DTO demands: one path separator in a
    // slug and every file in the backup becomes unimportable by that rule alone.
    for (const article of doc.articles) {
      expect(article.name.endsWith('.md'), article.name).toBe(true)
      expect(article.name).not.toContain('/')
      expect(article.name).not.toContain('\\')
    }
  })

  it('names the download from the server clock, never from the caller', async () => {
    const response = await exportRaw(
      // Two ways a caller might try to name the file it gets back. Neither is read:
      // the header value below is built from `new Date()` and nothing else.
      { ...adminAuth(), 'x-filename': 'evil.json' },
      '/api/v1/admin/articles/export?filename=evil.json',
    )
    const disposition = response.headers['content-disposition']

    expect(typeof disposition).toBe('string')
    expect(disposition).toMatch(/^attachment; filename="myblog-export-\d{4}-\d{2}-\d{2}\.json"$/)
    expect(disposition).not.toContain('evil')

    // Header and payload agree on the day, which is the only claim that survives being
    // run across UTC midnight: both come from the same clock reading.
    const doc = response.json() as ExportedBlog
    expect(disposition).toBe(`attachment; filename="${buildExportFilename(new Date(doc.exportedAt))}"`)
  })

  it('carries the bodies whole — the oversized fixture arrives at its full size', async () => {
    const doc = await exportDoc()
    const oversized = entryFor(doc, 'oversized')
    const bytes = Buffer.byteLength(oversized.markdown, 'utf8')

    // ~118 kB of markdown in one entry: a limit, a slice or a half-written stream
    // anywhere on this path shows up immediately as a small number.
    expect(bytes).toBeGreaterThan(100_000)
    expect(oversized.markdown).toBe(fixtureFiles.get('oversized.md'))

    /**
     * The margin that justifies `ExportedArticleFileSchema` existing separately from
     * `ImportArticleFileSchema`. Responses are run through zod's `safeEncode` by the
     * serializer (see the schema's comment), so reusing the import's DTO here would have
     * applied the import's write-path ceiling to the backup: this file sits only
     * 13 kB under `IMPORT_MAX_MARKDOWN_BYTES`, so the endpoint would start answering 500
     * on the largest thing the store already holds, and on any longer post after that.
     */
    expect(bytes).toBeLessThanOrEqual(IMPORT_MAX_MARKDOWN_BYTES)
  })
})

describe('the exported markdown is the import format', () => {
  it('is byte-identical to each of the seven seed fixtures on disk', async () => {
    const doc = await exportDoc()

    // Control: the map this loop reads is the seven files the seed loaded, not an empty
    // directory that would make the whole test pass by iterating nothing.
    expect(fixtureFiles.size).toBe(7)

    for (const [file, raw] of fixtureFiles) {
      const slug = parseFixture(raw, file).slug

      // Not "parses the same" — the same bytes. That is the strongest available claim
      // that the renderer is `parseFixture`'s inverse, and it is what makes a restored
      // article equal to the file the owner keeps locally.
      expect(entryFor(doc, slug).markdown, `fixtures/${file} does not round-trip byte for byte`).toBe(raw)
    }
  })

  it('re-parses every exported file and re-validates it against the create DTO', async () => {
    const doc = await exportDoc()
    expect(doc.articles.length).toBeGreaterThan(0)

    for (const file of doc.articles) {
      // The same parser the import runs, given the same `name` as its source label.
      const fixture = parseFixture(file.markdown, file.name)

      // The same mapping `toDraftInput` performs, so this walks the import's door
      // rather than a friendlier one invented here.
      const validated = CreateArticleSchema.safeParse({
        slug: fixture.slug,
        title: fixture.title,
        excerpt: fixture.excerpt,
        content: fixture.body,
        category: fixture.category,
        tags: fixture.tags,
        coverImage: fixture.coverImage,
        readTime: fixture.readTime,
      })
      // A throw rather than `expect(success).toBe(true)`: TypeScript only narrows
      // `data` on the guarded branch, and the message names the file and the field,
      // which is the same thing `toDraftInput` does for a real caller.
      if (!validated.success) {
        const reasons = validated.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
        throw new Error(`${file.name} fails the create DTO — ${reasons}`)
      }

      // Field-level truth, not just "it parsed".
      expect(validated.data.slug).toBe(file.name.replace(/\.md$/, ''))
      expect(validated.data.title).toBe(fixture.title)
      expect(validated.data.content).toBe(fixture.body)
      expect(validated.data.readTime).toBe(fixture.readTime)
    }
  })
})

describe('every status is exported (drafts included)', () => {
  it('includes the seeded draft and a live archived row that both other read paths refuse', async () => {
    const draft = newSlug('draft')
    const archived = newSlug('archived')
    await createArticle(draft, 'A draft that must be in the backup')
    await createArticle(archived, 'An archived row that must be in the backup')
    await setStatus(archived, 'archived')

    const doc = await exportDoc()
    expect(entryFor(doc, draft).markdown).toContain('status: draft')
    expect(entryFor(doc, archived).markdown).toContain('status: archived')
    expect(entryFor(doc, 'draft-unpublished').markdown).toContain('status: draft')

    /**
     * The control, and the reason the three lines above are about the export rather
     * than about the world being full of drafts: the two surfaces this endpoint must NOT
     * be modelled on both refuse these rows. If a mutation quietly reused either of
     * their filters, this is what goes red beside them — and if the filters themselves
     * changed, this says so instead of the export test agreeing with a wrong world.
     */
    const publicPage = (
      await app.inject({ method: 'GET', url: '/api/v1/articles?limit=50' })
    ).json() as ArticlePage
    const publicSlugs = publicPage.data.map((row) => row.slug)
    expect(publicSlugs).not.toContain(draft)
    expect(publicSlugs).not.toContain(archived)
    expect(publicSlugs).not.toContain('draft-unpublished')

    const publishedOnly = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/articles?status=published&limit=50',
      headers: adminAuth(),
    })
    expect(publishedOnly.statusCode).toBe(200)
    const adminPublished = (publishedOnly.json() as AdminArticlePage).data.map((row) => row.slug)
    expect(adminPublished).not.toContain(archived)
    expect(adminPublished).not.toContain(draft)
    expect(adminPublished.length).toBeGreaterThan(0)

    // Still exactly the table: no status filtered out, and nothing invented either.
    expect(doc.articles.length).toBe(await articleCount())

    await deleteRows([draft, archived])
    expect((await exportDoc()).articles.length).toBe(await articleCount())
  })
})

describe('the order is deterministic', () => {
  it('is published_at desc nulls last, slug — computed from the fixtures, not from the query', async () => {
    /**
     * Two drafts whose only difference is their names. Every seeded published article has
     * a timestamp of its own and the seed holds exactly one draft, so without a tie
     * group the `slug` half of the `ORDER BY` is never exercised and a mutation to it
     * would survive. The NULL group is where determinism actually has to be proven.
     */
    const createdFirst = newSlug('tie-zzz')
    const createdSecond = newSlug('tie-aaa')
    await createArticle(createdFirst, 'Created first, sorts second')
    await createArticle(createdSecond, 'Created second, sorts first')

    // Both really are in the tie group: nothing but the slug to sort on.
    expect((await snapshotRow(createdFirst)).published_at).toBeNull()
    expect((await snapshotRow(createdSecond)).published_at).toBeNull()

    const doc = await exportDoc()
    const expected = expectedExportOrder(fixtureFiles, [createdFirst, createdSecond])
    const known = new Set(expected.map((slug) => `${slug}.md`))
    const window = doc.articles.map((file) => file.name).filter((name) => known.has(name))

    // The relative order of every slug this file knows about. Comparing the whole
    // sequence against a set derived from the fixtures is what a missing or reordered
    // `ORDER BY` cannot survive; filtering to the known slugs is what stops another
    // suite's residue from turning a correct export red.
    expect(window).toEqual(expected.map((slug) => `${slug}.md`))
    // Control against a vacuous comparison: seven fixtures plus the two tie rows. An
    // empty or one-element `window` would mean the filter matched nothing at all.
    expect(window.length).toBeGreaterThanOrEqual(9)

    // The tie-breaker stated where a reader can see what it rules out: creation order,
    // insertion order and physical order all put `createdFirst` before `createdSecond`.
    expect(window.indexOf(`${createdSecond}.md`)).toBeLessThan(window.indexOf(`${createdFirst}.md`))

    await deleteRows([createdFirst, createdSecond])
  })

  it('produces the same bytes twice for the same data', async () => {
    const first = await exportDoc()
    const second = await exportDoc()

    // The article sequence — the part anyone would actually diff — is byte-identical.
    expect(JSON.stringify(second.articles)).toBe(JSON.stringify(first.articles))

    /**
     * And the document as a whole is NOT claimed to be. `exportedAt` is the server's
     * clock and legitimately differs between two calls, so reproducibility is asserted
     * one level down. Written as an assertion here rather than a footnote because "two
     * exports of an unchanged database are the same file" is false as stated, and a
     * backup tool that oversells itself is worse than one with a documented gap. (Not
     * `expect(first.exportedAt).not.toBe(second.exportedAt)`: two calls inside one
     * millisecond are equal, and a test that can only pass by being flaky is not proof
     * of anything.)
     */
    expect(new Date(second.exportedAt).getTime()).toBeGreaterThanOrEqual(new Date(first.exportedAt).getTime())
  })
})

describe('the round trip: export it, delete it, import it back', () => {
  it('restores the article through POST /articles/import using the export entry itself', async () => {
    const baseline = roundTripBaseline
    if (baseline === null) throw new Error('beforeAll did not capture the round-trip baseline')

    const before = await articleCount()
    const commentsBefore = await commentCount()

    // The export is the payload's only source. Nothing here is hand-assembled, so a
    // renderer bug cannot be papered over by a test that writes its own front-matter.
    const doc = await exportDoc()
    const entry = entryFor(doc, ROUND_TRIP_SLUG)
    const exportedBody = parseFixture(entry.markdown, entry.name).body

    // The article really was published beforehand, or "it came back a draft" would prove
    // nothing about the status the markdown path cannot carry.
    expect(baseline.status).toBe('published')
    expect(baseline.published_at).not.toBeNull()

    // 1. Remove it, through the API a person would use.
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/articles/${ROUND_TRIP_SLUG}`,
      headers: adminWriteHeaders(),
    })
    expect(removed.statusCode).toBe(204)
    // Control: the row is really gone, so the import below cannot be re-using it.
    expect(await articleCount()).toBe(before - 1)

    // 2. Put it back with the export's own `{name, markdown}` object — no translation,
    //    no re-parse, no reshaping. That this compiles into the import body is the same
    //    symmetry `EXPORT_MATCHES_CONTRACT` asserts at build time.
    const restored = await app.inject({
      method: 'POST',
      url: '/api/v1/articles/import',
      headers: adminWriteHeaders(),
      payload: { files: [entry] },
    })
    expect(restored.statusCode).toBe(200)
    const article = createdResult(restored, entry.name).article

    expect(article.slug).toBe(baseline.slug)
    expect(article.title).toBe(baseline.title)
    expect(article.excerpt).toBe(baseline.excerpt)
    expect(article.category).toBe(baseline.category)
    expect(article.tags).toEqual(baseline.tags)
    expect(article.coverImage).toBe(baseline.cover_image)
    expect(article.readTime).toBe(baseline.read_time)

    // The body, byte for byte, from two directions: against the stored text the export
    // started from, and against what the parser finds in the file now — plus the row
    // read back below. These content comparisons are the round trip's teeth: with only
    // title/excerpt/category/tags equal, a renderer that altered the body still passes
    // (verified by mutation, see the stage notes).
    expect(article.content).toBe(baseline.content_md)
    expect(exportedBody).toBe(baseline.content_md)
    expect(article.content).toBe(exportedBody)

    // Import never publishes (S3-R9), and this proves the export does not work around it
    // by smuggling a status through: the file plainly says `published`, and the row does
    // not become published. The original first-publish time is therefore NOT restored —
    // the gap the route's comment names.
    expect(entry.markdown).toContain(`status: ${baseline.status}`)
    expect(article.status).toBe('draft')
    expect(article.publishedAt).toBeNull()

    const nowRow = await snapshotRow(ROUND_TRIP_SLUG)
    expect(nowRow.status).toBe('draft')
    expect(nowRow.published_at).toBeNull()
    expect(nowRow.content_md).toBe(baseline.content_md)

    // 3. Put the seed baseline back, id and timestamps included, so the gates that run
    //    after this suite still find `articles 7 / comments 2`.
    await deleteRows([ROUND_TRIP_SLUG])
    await restoreRow(baseline)
    expect(await articleCount()).toBe(before)
    expect(await commentCount()).toBe(commentsBefore)
    expect(await snapshotRow(ROUND_TRIP_SLUG)).toEqual(baseline)
  })
})

describe('export authorisation — reverse tests', () => {
  it('refuses no credentials with 401 and delivers no article text at all', async () => {
    const before = await articleCount()
    const response = await exportRaw({})
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe(ERROR_CODES.unauthorized)
    expect(await articleCount()).toBe(before)

    // A refusal must not become a delivery. These strings live in the seeded drafts an
    // unauthenticated caller has no right to; the handler never runs, so no body can be
    // here — which is what these lines say.
    expect(response.body).not.toContain('slug: draft-unpublished')
    expect(response.body).not.toContain('draft-unpublished.md')
    expect(response.headers['content-disposition']).toBeUndefined()
  })

  it('refuses a logged-in non-admin with 403', async () => {
    const before = await articleCount()
    const response = await exportRaw({ authorization: `Bearer ${tokenFor(users.plain)}` })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe(ERROR_CODES.forbidden)
    expect(await articleCount()).toBe(before)
    expect(response.body).not.toContain('slug: ')
  })

  it('refuses a non-admin carrying the CSRF header with 403 FORBIDDEN, not a CSRF code', async () => {
    // The guard-order proof copied from the admin reads: the header must never become
    // the thing that stands in for authorisation on a surface that serves drafts.
    const response = await exportRaw({
      authorization: `Bearer ${tokenFor(users.plain)}`,
      'x-requested-with': 'portal',
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe(ERROR_CODES.forbidden)
    expect(response.body).not.toContain(ERROR_CODES.csrfCheckFailed)
  })

  it('serves the export to an admin with no CSRF header at all', async () => {
    // The control for the guard list. If `requireCsrfHeader` were ever added to this GET
    // — copy-pasted from the write routes, where it belongs — this is 403 and the admin
    // page's download button stops working against a real session.
    const response = await exportRaw()
    expect(response.statusCode).toBe(200)
    expect((response.json() as ExportedBlog).articles.length).toBeGreaterThan(0)
  })

  it('writes nothing, and the counter measuring that can see a write', async () => {
    const rowBefore = await snapshotRow(UNTOUCHED_SLUG)
    const articlesBefore = await articleCount()
    const commentsBefore = await commentCount()

    const response = await exportRaw()
    expect(response.statusCode).toBe(200)

    // Not just "the count is the same": the whole row is identical, `views` and
    // `updated_at` included. "It is only a read" is exactly what a leaky export would
    // claim, and a row counter alone would agree with it while an incrementing read
    // updated everything else.
    expect(await articleCount()).toBe(articlesBefore)
    expect(await commentCount()).toBe(commentsBefore)
    expect(await snapshotRow(UNTOUCHED_SLUG)).toEqual(rowBefore)

    // The control. Without it the two assertions above could be reading a counter that
    // is stuck; a write that really lands moves it, so a refusal to move is a finding.
    const probe = newSlug('write-probe')
    await createArticle(probe, 'Proof the counter moves')
    expect(await articleCount()).toBe(articlesBefore + 1)
    expect(await snapshotRow(UNTOUCHED_SLUG)).toEqual(rowBefore)

    await deleteRows([probe])
    expect(await articleCount()).toBe(articlesBefore)
  })
})

describe('the export is outside the write rate limiter', () => {
  /**
   * A second app with `RATE_LIMIT_WRITE_PER_MINUTE: 1`, and two separate admin
   * identities so the shared Redis buckets cannot interfere with the rest of this file
   * or with each other.
   *
   * Both directions are proved, because the two ways this goes wrong are different:
   * - an identity whose write bucket is already full still gets 200 from the export
   *   (the guard is not attached, so it cannot refuse the backup);
   * - and an identity that has only exported can still write (the export spent no
   *   quota, so hammering the download cannot lock anyone out of the editor).
   * The first alone would pass with a route that charged the bucket but skipped the
   * check, which is a strange bug but not an impossible one.
   */
  /**
   * Built in this describe's `beforeAll`, not at collection time: the outer `beforeAll`
   * is what refuses to run without DATABASE_URL/REDIS_URL, and a module-level or
   * describe-body `buildApp` would connect to real infrastructure before that
   * precondition has been stated.
   */
  let tightApp: FastifyInstance

  beforeAll(async () => {
    tightApp = await buildApp({ config: { ...config, RATE_LIMIT_WRITE_PER_MINUTE: 1 } })
    await waitForRedis(tightApp)
  })

  afterAll(async () => {
    // Its own rows and users, whatever happened inside: the tight app shares the
    // database with the main one, so a row left here would land in the residue check.
    await tightApp.db.query(`delete from articles where slug like $1`, [`ex-${run}-%`])
    await tightApp.db.query(`delete from users where github_login like $1`, [`ex-tight-%-${run}`])
    await tightApp.close()
  })

  /** One admin of the tight app, with a bearer token and the CSRF header. */
  async function tightIdentity(tag: string): Promise<{ authorization: string; write: Record<string, string> }> {
    const login = `ex-tight-${tag}-${run}`
    const inserted = await tightApp.db.query<{ id: string }>(
      `insert into users (github_login, display_name, is_admin) values ($1, $2, true) returning id`,
      [login, `EX Tight ${tag}`],
    )
    const authorization = `Bearer ${tightApp.signAccessToken({ sub: inserted.rows[0]!.id, jti: generateJti() })}`
    return { authorization, write: { authorization, 'x-requested-with': 'portal' } }
  }

  function writeArticle(value: string, headers: Record<string, string>) {
    return tightApp.inject({
      method: 'POST',
      url: '/api/v1/articles',
      headers,
      payload: {
        slug: value,
        title: 'A write inside the tight window',
        excerpt: 'e',
        content: 'c',
        category: CATEGORY,
        tags: [],
      },
    })
  }

  it('refuses a second write but still serves the export to the same identity', async () => {
    const caller = await tightIdentity('exhausted')
    const slug = newSlug('limited')
    const refusedSlug = newSlug('limited-refused')

    try {
      expect((await writeArticle(slug, caller.write)).statusCode).toBe(201)
      // The bucket really is full, or the export's 200 below proves nothing.
      const refused = await writeArticle(refusedSlug, caller.write)
      expect(refused.statusCode).toBe(429)
      expect(refused.json().error.code).toBe(ERROR_CODES.rateLimited)

      const exported = await tightApp.inject({
        method: 'GET',
        url: '/api/v1/admin/articles/export',
        headers: { authorization: caller.authorization },
      })
      expect(exported.statusCode).toBe(200)
      expect((exported.json() as ExportedBlog).articles.length).toBeGreaterThan(0)
      expect(exported.headers['content-disposition']).toBeDefined()
    } finally {
      // Deleted here rather than only in `afterAll`: the residue check at the end of this
      // file compares the table against the count taken before it started.
      await deleteRows([slug, refusedSlug])
    }
  })

  it('costs no write quota: an identity that has only exported can still write', async () => {
    const caller = await tightIdentity('untraveled')
    const slug = newSlug('after-export')

    try {
      const exported = await tightApp.inject({
        method: 'GET',
        url: '/api/v1/admin/articles/export',
        headers: { authorization: caller.authorization },
      })
      expect(exported.statusCode).toBe(200)

      // With a ceiling of 1 per minute, a read that charged the write bucket would make
      // this 429.
      expect((await writeArticle(slug, caller.write)).statusCode).toBe(201)
    } finally {
      await deleteRows([slug])
    }
  })
})

describe('the /export path shadows an article slug of the same name', () => {
  /**
   * The consequence the route comment promises rather than hides. `GET
   * /api/v1/admin/articles/export` and `GET /api/v1/admin/articles/:slug` are the same
   * URL for `slug = 'export'`, and the static branch wins: such an article is in the
   * backup but cannot be opened by the editor. Pinned here so that if the path ever
   * moves — or the write side learns to refuse the slug — this test is where the change
   * has to be recorded.
   */
  it('answers with the document, and the article is still inside it', async () => {
    const shadowed = 'export'
    createdSlugs.push(shadowed)
    await createArticle(shadowed, 'An article whose slug is the export path')

    const response = await exportRaw()
    expect(response.statusCode).toBe(200)
    const doc = response.json() as ExportedBlog
    // The document, not the article: no `title` at the top level, and a `version`.
    expect(doc.version).toBe(1)
    expect(doc).not.toHaveProperty('title')
    expect(entryFor(doc, shadowed).markdown).toContain('status: draft')

    // Control: the parametric sibling still serves every other slug, so this is one
    // collision rather than a broken detail route.
    const other = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/articles/draft-unpublished',
      headers: adminAuth(),
    })
    expect(other.statusCode).toBe(200)
    expect(other.json().slug).toBe('draft-unpublished')

    await deleteRows([shadowed])
  })
})

describe('rendering and naming, at the unit boundary', () => {
  it('writes no key the front-matter parser does not know, because one would break every file', () => {
    const markdown = renderArticleMarkdown(record())

    // `parseFixture` rejects unknown keys outright, so emitting the tempting extras — a
    // modification timestamp, the row id, the view count — would make the whole backup
    // unimportable rather than merely lossy.
    expect(markdown).not.toContain('updatedAt:')
    expect(markdown).not.toContain('updated_at:')
    expect(markdown).not.toContain('views:')
    expect(markdown).not.toContain('id:')
    expect(markdown).not.toContain('publishedAt: null')

    // Control: the render is not broken in some other way that lets the `not.toContain`
    // bunch pass for the wrong reason.
    expect(parseFixture(markdown, 'unit').slug).toBe('unit-render')
  })

  it('writes a whole second without a millisecond part and a real millisecond with one', () => {
    expect(renderArticleMarkdown(record({ publishedAt: '2026-09-20T10:00:00.000Z' }))).toContain(
      'publishedAt: 2026-09-20T10:00:00Z',
    )
    expect(renderArticleMarkdown(record({ publishedAt: '2026-09-20T10:00:00.595Z' }))).toContain(
      'publishedAt: 2026-09-20T10:00:00.595Z',
    )
    // A draft has no time to write, and `publishedAt: null` would be a claim rather than
    // an absence.
    expect(renderArticleMarkdown(record({ publishedAt: null, status: 'draft' }))).not.toContain('publishedAt')
  })

  it('names the download after UTC, not the process zone or locale', () => {
    // 23:30 UTC on the 9th is already the 10th in UTC+8: a local-time name would be a
    // day away from the instant the copy was taken.
    expect(buildExportFilename(new Date('2026-01-09T23:30:00.000Z'))).toBe('myblog-export-2026-01-09.json')
    expect(buildExportFilename(new Date('2026-12-01T00:00:00.000Z'))).toBe('myblog-export-2026-12-01.json')
    expect(buildExportFilename(new Date('2026-01-09T00:00:00.000Z'))).toMatch(
      /^myblog-export-\d{4}-\d{2}-\d{2}\.json$/,
    )
  })

  it('documents what the flat front-matter cannot carry instead of hiding it', () => {
    /**
     * Characterisation tests for the renderer's known limits. The values are written
     * verbatim — nothing here escapes, quotes or re-folds them, because doing that would
     * make the backup describe something other than what is stored. The price is a few
     * legal database values that cannot come back through the import, pinned here so a
     * future change has to say so too rather than discover it during a restore.
     */
    const multiline = renderArticleMarkdown(record({ title: 'two\nlines' }))
    expect(multiline).toContain('title: two\nlines')
    expect(() => parseFixture(multiline, 'multiline-title')).toThrow(FixtureError)

    // A leading newline in the body is the parser's, not the renderer's: one is eaten.
    const leading = record({ contentMd: '\n# Body\n' })
    expect(parseFixture(renderArticleMarkdown(leading), 'leading-newline').body).toBe('# Body\n')

    // Tags are a comma-separated list in this format, so a comma inside one tag reads
    // back as two tags.
    expect(parseFixture(renderArticleMarkdown(record({ tags: ['a, b'] })), 'comma-tag').tags).toEqual(['a', 'b'])

    // Whitespace at the edges of a value is trimmed by the parser.
    expect(parseFixture(renderArticleMarkdown(record({ title: '  spaced  ' })), 'padded').title).toBe('spaced')

    // And a slug holding a path separator yields a file name the import's own DTO
    // refuses. Slug shape is unvalidated beyond length on the write side, so this is a
    // gap in the write rules that the export merely makes visible.
    const hostileSlug = record({ slug: 'a/b' })
    expect(
      ImportArticleFileSchema.safeParse({ name: `${hostileSlug.slug}.md`, markdown: renderArticleMarkdown(hostileSlug) })
        .success,
    ).toBe(false)
  })
})

describe('structural guard: the export SQL lives only in the repository', () => {
  it('no layer but repository.ts queries the articles table', () => {
    const files = matchedFiles(
      gitGrepArticlesModule('from articles|insert into articles|update articles|delete from articles'),
    )

    expect(files.every((file) => file.endsWith('repository.ts'))).toBe(true)
    expect(files.length, 'pathspec matched no file; the guard above is vacuous').toBeGreaterThan(0)
  })

  it('polices the export statement rather than passing beside it', () => {
    // Same shape as the admin list's guard: `from articles` is already satisfied by the
    // three pre-existing queries, so naming the export's own projection is what makes the
    // scan cover this stage's addition. The service's `listAllForExport()` call is
    // deliberately not in the pattern — that lives in service.ts by design, and this
    // guard is about SQL text.
    const out = gitGrepArticlesModule('EXPORT_COLUMNS')
    const files = matchedFiles(out)

    expect(files.every((file) => file.endsWith('repository.ts'))).toBe(true)
    // Declaration *and* the statement that interpolates it: one match would mean the
    // projection is defined but no query reads it, i.e. this guard is not looking at the
    // export's SQL at all.
    expect(files.length, 'export projection found, but not in a statement').toBeGreaterThanOrEqual(2)
  })

  it('orders the export on the keys the determinism test claims', () => {
    // The two claims have to move together. Re-ordering by `updated_at` — deterministic
    // per row, but it reshuffles the whole backup on every save — turns this red at the
    // place it changed, while the oracle test says what broke.
    const out = gitGrepArticlesModule('order by published_at desc nulls last, slug')
    expect(out, 'the export ORDER BY is not what the determinism test assumes').toContain('repository.ts')
  })
})

describe('residue', () => {
  it('leaves the seeded table exactly as this file found it', async () => {
    // Last in this file on purpose: every row created above is deleted by the test that
    // created it, so a count back to the entry baseline means the file as a whole was a
    // clean reader. `afterAll` is the backstop if an assertion threw first.
    expect(await articleCount()).toBe(baselineArticles)
    expect(await commentCount()).toBe(baselineComments)

    const leftovers = await app.db.query<{ n: number }>(
      `select count(*)::int as n from articles where slug like $1`,
      [`ex-${run}-%`],
    )
    expect(leftovers.rows[0]!.n).toBe(0)

    if (roundTripBaseline !== null) {
      // The article the round trip deleted and re-imported is back as the seed left it:
      // published, with its original first-publish timestamp.
      expect(await snapshotRow(ROUND_TRIP_SLUG)).toEqual(roundTripBaseline)
    }
  })
})
