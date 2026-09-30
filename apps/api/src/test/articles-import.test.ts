import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { ERROR_CODES, type ArticlePage, type ImportArticleResult, type ImportArticlesResponse } from 'shared'
import { buildApp } from '../app.js'
import { ApiError } from '../errors.js'
import { loadConfig } from '../config/index.js'
import { generateJti } from '../lib/tokens.js'
import { ArticleService } from '../modules/articles/service.js'
import {
  IMPORT_BODY_LIMIT_BYTES,
  IMPORT_MAX_FILES,
  IMPORT_MAX_MARKDOWN_BYTES,
  IMPORT_MAX_NAME_LENGTH,
  IMPORT_MAX_TOTAL_MARKDOWN_BYTES,
} from '../modules/articles/schema.js'
import { waitForRedis } from './wait-for-redis.js'

/**
 * Markdown import (S3 stage C, `POST /api/v1/articles/import`).
 *
 * Real Fastify + real Postgres + real Redis, because the two properties under test
 * cannot be observed any other way: "one bad file means the table did not change"
 * is a statement about rows, and "a conflict is per file, not per batch" is a
 * statement about the unique index actually being there.
 *
 * The size ceilings are imported from the schema module rather than repeated here,
 * so a limit change cannot silently turn these assertions into no-ops — the same
 * reason `comments-write.test.ts` imports `COMMENT_MAX_LENGTH`.
 */
let app: FastifyInstance
const config = loadConfig()

const users: { admin: string; plain: string } = { admin: '', plain: '' }

/** Unique per run: slugs and logins never collide with another run's rows. */
const run = randomUUID().slice(0, 8)
const slugOf = (name: string): string => `ai-${run}-${name}`

/** Category every fixture here uses, which makes the public-list check exact. */
const CATEGORY = 'Imported'

function tokenFor(userId: string): string {
  return app.signAccessToken({ sub: userId, jti: generateJti() })
}

/** Admin credentials plus the CSRF header every write requires. */
function adminHeaders(): Record<string, string> {
  return { authorization: `Bearer ${tokenFor(users.admin)}`, 'x-requested-with': 'portal' }
}

async function importFiles(
  files: unknown,
  headers: Record<string, string> = adminHeaders(),
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/articles/import',
    headers,
    payload: { files },
  })
}

/**
 * Total rows in `articles`, for the "nothing was written" proofs.
 *
 * A global count is meaningful here only because `vitest.config.ts` sets
 * `fileParallelism: false`, so no other test file is writing while this one runs.
 * It is always compared to itself before/after and never to a hard-coded number,
 * so what other suites leave behind cannot break the assertion.
 */
async function articleCount(): Promise<number> {
  const { rows } = await app.db.query<{ n: number }>('select count(*)::int as n from articles')
  return rows[0]!.n
}

interface StoredRow {
  slug: string
  status: string
  published_at: string | null
}

async function storedRows(values: string[]): Promise<StoredRow[]> {
  // A zero-length list makes `= any('{}')` match nothing, so every
  // `toHaveLength(0)` assertion downstream would pass having observed an empty
  // result set it never queried for. Fail loudly instead.
  if (values.length === 0) throw new Error('storedRows([]) asserts nothing; pass the slugs to check')

  const { rows } = await app.db.query<StoredRow>(
    // The explicit cast is not decoration: `= any($1)` without it leaves Postgres
    // unable to infer the parameter's type from a text[] column and it fails with
    // `could not determine data type of parameter $1`.
    `select slug, status, published_at from articles where slug = any ($1::text[])`,
    [values],
  )
  return rows
}

async function publicList(): Promise<ArticlePage> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/articles?limit=50&category=${CATEGORY}`,
  })
  return response.json() as ArticlePage
}

/**
 * Front-matter builder. Deliberately emits only the flat `key: value` form with
 * the `[a, b]` tag list — i.e. the format `parseFixture` accepts — so a failure
 * here means the endpoint is wrong, not the fixture.
 */
interface MarkdownOptions {
  fields?: Record<string, string>
  omit?: string[]
  body?: string
}

function markdown(value: string, opts: MarkdownOptions = {}): string {
  const fields: Record<string, string> = {
    slug: value,
    title: `Imported ${value}`,
    excerpt: 'a short excerpt',
    category: CATEGORY,
    tags: '[demo, import]',
    status: 'draft',
    ...opts.fields,
  }

  // `publishedAt` is emitted last so it reads as the optional trailing key it is;
  // anything else the caller supplied (readTime, or a key the parser does not
  // know) keeps the order the caller wrote it in.
  const publishedAt = fields.publishedAt
  const omitted = opts.omit ?? []
  const entries = Object.entries(fields).filter(
    ([key]) => key !== 'publishedAt' && !omitted.includes(key),
  )
  if (publishedAt !== undefined) entries.push(['publishedAt', publishedAt])

  // The trailing newline matters: the parser looks for the literal `\n---\n`.
  const body = opts.body ?? '# Body\n\nimported text'
  return `---\n${entries.map(([key, emitted]) => `${key}: ${emitted}`).join('\n')}\n---\n${body}\n`
}

function padTo(bytes: number): string {
  return 'x'.repeat(bytes)
}

function results(response: LightMyRequestResponse): ImportArticleResult[] {
  return (response.json() as ImportArticlesResponse).results
}

function errorMessage(response: LightMyRequestResponse): string {
  return response.json().error.message as string
}

function createdArticle(result: ImportArticleResult | undefined, file: string) {
  if (result === undefined || result.kind !== 'created') {
    throw new Error(`expected ${file} to be created, got ${JSON.stringify(result)}`)
  }
  return result
}

function conflictResult(result: ImportArticleResult | undefined, file: string) {
  if (result === undefined || result.kind !== 'conflict') {
    throw new Error(`expected ${file} to conflict, got ${JSON.stringify(result)}`)
  }
  return result
}

/**
 * Driver and framework internals must never reach the wire (design §1.2,
 * conventions §2). For this endpoint the parser's own exception identity belongs in
 * the same category: a stack trace describes our code, not the caller's problem.
 */
function expectNoInternalsLeaked(response: LightMyRequestResponse): void {
  for (const marker of ['23505', '23503', 'FST_ERR', 'FixtureError', 'ERR_MODULE', '    at ']) {
    expect(response.body, `response leaked ${marker}`).not.toContain(marker)
  }
}

beforeAll(async () => {
  if (process.env.DATABASE_URL === undefined || process.env.REDIS_URL === undefined) {
    throw new Error('DATABASE_URL and REDIS_URL are required for article import tests')
  }

  app = await buildApp({ config })
  await waitForRedis(app)

  const inserted = await app.db.query<{ id: string; github_login: string }>(
    `insert into users (github_login, display_name, is_admin)
       values ($1, 'AI Admin', true), ($2, 'AI Plain', false)
       returning id, github_login`,
    [`ai-admin-${run}`, `ai-plain-${run}`],
  )
  for (const row of inserted.rows) {
    if (row.github_login === `ai-admin-${run}`) users.admin = row.id
    else users.plain = row.id
  }
})

afterAll(async () => {
  // In afterAll, not at the end of a test body: an assertion failing mid-test must
  // still not leave these rows behind to poison the next run.
  if (app?.db) {
    // Run-scoped slug sweep: catches rows written before a test threw, which a
    // hand-maintained list of slugs would miss. No seed fixture slug starts with
    // `ai-`, so nothing outside this suite's naming can match.
    await app.db.query(`delete from articles where slug like $1`, [`ai-${run}-%`])
    // Login prefix rather than id: an empty id (if beforeAll itself failed) would
    // throw on the uuid cast and bury the real error.
    await app.db.query(`delete from users where github_login like 'ai-%'`)
  }
  await app?.close()
})

describe('POST /api/v1/articles/import — happy path', () => {
  it('imports three files as drafts the public surface does not serve', async () => {
    const slugs = ['alpha', 'beta', 'gamma'].map(slugOf)
    const files = slugs.map((value, index) => ({ name: `file-${index}.md`, markdown: markdown(value) }))

    const response = await importFiles(files)
    expect(response.statusCode).toBe(200)
    expectNoInternalsLeaked(response)

    const body = results(response)
    expect(body).toHaveLength(3)
    // One result per file, in the order they arrived, each naming its own file.
    expect(body.map((r) => r.name)).toEqual(['file-0.md', 'file-1.md', 'file-2.md'])

    for (const value of slugs) {
      const found = body.find((r) => (r.kind === 'created' ? r.article.slug : r.slug) === value)
      expect(found?.kind, `expected ${value} to be created`).toBe('created')
      if (found?.kind === 'created') {
        // The admin shape comes back whole and says `draft` — which is how the
        // person importing learns that S3-R9 held, without querying anything.
        expect(found.article.status).toBe('draft')
        expect(found.article.publishedAt).toBeNull()
        expect(found.article.title).toBe(`Imported ${value}`)
      }
    }

    const rows = await storedRows(slugs)
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.status === 'draft' && row.published_at === null)).toBe(true)

    // Drafts are invisible publicly. The filtered list is the exact proof: nothing
    // in this suite publishes, so this category must have no published members.
    expect((await publicList()).data).toHaveLength(0)
    for (const value of slugs) {
      const detail = await app.inject({ method: 'GET', url: `/api/v1/articles/${value}` })
      expect(detail.statusCode).toBe(404)
    }
  })

  it('carries the parsed front-matter through to the stored row', async () => {
    const value = slugOf('fields')
    const response = await importFiles([
      {
        name: 'fields.md',
        markdown: markdown(value, {
          fields: { title: '字段检查', excerpt: '摘要', tags: '[甲, 乙]', readTime: '9' },
        }),
      },
    ])
    expect(response.statusCode).toBe(200)

    const article = createdArticle(results(response)[0], 'fields.md').article
    expect(article.title).toBe('字段检查')
    expect(article.excerpt).toBe('摘要')
    expect(article.category).toBe(CATEGORY)
    expect(article.tags).toEqual(['甲', '乙'])
    expect(article.readTime).toBe(9)
    expect(article.content).toContain('# Body')

    // `readTime: 9` and the tags are not just echoed from the request: they are
    // read back out of the row the insert returned.
    const rows = await app.db.query<{ read_time: number; tags: string[] }>(
      'select read_time, tags from articles where slug = $1',
      [value],
    )
    expect(rows.rows[0]!.read_time).toBe(9)
    expect(rows.rows[0]!.tags).toEqual(['甲', '乙'])
  })
})

describe('one bad file aborts the whole batch (S3-R11)', () => {
  it('answers 400 for a batch with a missing key and leaves the row count untouched', async () => {
    const good = [slugOf('partial-a'), slugOf('partial-b')]
    const before = await articleCount()

    const response = await importFiles([
      { name: 'first.md', markdown: markdown(good[0]!) },
      { name: 'broken.md', markdown: markdown(slugOf('partial-bad'), { omit: ['title'] }) },
      { name: 'third.md', markdown: markdown(good[1]!) },
    ])

    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe(ERROR_CODES.badRequest)
    // The message must identify the file (design §6) — the whole reason `name` is
    // threaded into the parser as its source.
    expect(errorMessage(response)).toContain('broken.md')
    expect(errorMessage(response)).toContain('title')
    expectNoInternalsLeaked(response)

    // The load-bearing assertion: a 400 alone says nothing about whether the two
    // valid files were written first. Count, import, count again.
    expect(await articleCount()).toBe(before)
    expect(await storedRows(good)).toHaveLength(0)
    expect(await storedRows([slugOf('partial-bad')])).toHaveLength(0)
  })

  it('refuses every input the seed parser refuses, naming the file each time', async () => {
    const before = await articleCount()
    // Every one of these carries this run's slug so that even if a parser change
    // let a file through, the row it wrote is still inside `afterAll`'s sweep.
    const s = slugOf('parser-case')
    const cases: { label: string; file: string }[] = [
      { label: 'no front-matter at all', file: 'just prose\n' },
      { label: 'unclosed front-matter', file: `---\nslug: ${s}\ntitle: t\n` },
      {
        label: 'indented yaml list',
        file: `---\nslug: ${s}\ntitle: t\nexcerpt: e\ncategory: c\ntags:\n  - a\nstatus: draft\n---\nbody\n`,
      },
      {
        label: 'comment line',
        file: `---\n# note\nslug: ${s}\ntitle: t\nexcerpt: e\ncategory: c\ntags: []\nstatus: draft\n---\nbody\n`,
      },
      {
        label: 'unknown key',
        file: `---\nslug: ${s}\ntitle: t\nexcerpt: e\ncategory: c\ntags: []\nstatus: draft\nauthor: someone\n---\nbody\n`,
      },
      {
        label: 'duplicate key',
        file: `---\nslug: ${s}\nslug: ${s}-2\ntitle: t\nexcerpt: e\ncategory: c\ntags: []\nstatus: draft\n---\nbody\n`,
      },
      { label: 'bad status word', file: markdown(s, { fields: { status: 'ready' } }) },
      { label: 'published without timestamp', file: markdown(s, { fields: { status: 'published' } }) },
      { label: 'tags not in bracket form', file: markdown(s, { fields: { tags: 'a, b' } }) },
    ]

    for (const [index, testCase] of cases.entries()) {
      const response = await importFiles([{ name: `case-${index}.md`, markdown: testCase.file }])
      expect(response.statusCode, `${testCase.label} → 400`).toBe(400)
      expect(response.json().error.code, testCase.label).toBe(ERROR_CODES.badRequest)
      // Always names the file, so the person knows which one to fix.
      expect(errorMessage(response), `${testCase.label} names the file`).toContain(`case-${index}.md`)
      expectNoInternalsLeaked(response)
    }

    expect(await articleCount()).toBe(before)
  })

  it('rejects a file that parses but violates the create endpoint’s field bounds', async () => {
    // The parser validates the front-matter *block*; the article fields themselves
    // are bounded by `CreateArticleSchema`. Import goes through that same DTO, so it
    // cannot become a side door that writes rows `POST /api/v1/articles` refuses. An
    // empty excerpt and a body-less file both parse cleanly and neither is caught by
    // a column constraint — the DTO is the only thing standing between them and the
    // table.
    const before = await articleCount()

    const emptyExcerpt = await importFiles([
      {
        name: 'blank-excerpt.md',
        markdown: markdown(slugOf('blank-excerpt'), { fields: { excerpt: '' } }),
      },
    ])
    expect(emptyExcerpt.statusCode).toBe(400)
    expect(emptyExcerpt.json().error.code).toBe(ERROR_CODES.badRequest)
    expect(errorMessage(emptyExcerpt)).toContain('blank-excerpt.md')
    expectNoInternalsLeaked(emptyExcerpt)

    const emptyBody = await importFiles([
      { name: 'no-body.md', markdown: markdown(slugOf('no-body'), { body: '' }) },
    ])
    expect(emptyBody.statusCode).toBe(400)
    expectNoInternalsLeaked(emptyBody)

    expect(await articleCount()).toBe(before)
    expect(await storedRows([slugOf('blank-excerpt'), slugOf('no-body')])).toHaveLength(0)
  })
})

describe('an import is always a draft (S3-R9)', () => {
  it('ignores a front-matter status of published and stores a draft anyway', async () => {
    const value = slugOf('says-published')
    const response = await importFiles([
      {
        name: 'published.md',
        // The timestamp is included because the parser requires it for `published`
        // — the file is well-formed, it simply does not get what it asks for.
        markdown: markdown(value, {
          fields: { status: 'published', publishedAt: '2026-01-01T00:00:00Z' },
        }),
      },
    ])
    expect(response.statusCode).toBe(200)

    const article = createdArticle(results(response)[0], 'published.md').article
    expect(article.status).toBe('draft')
    expect(article.publishedAt).toBeNull()

    // Not just the response echo: the row itself.
    const [row] = await storedRows([value])
    expect(row?.status).toBe('draft')
    expect(row?.published_at).toBeNull()

    // And it is not publicly readable.
    const detail = await app.inject({ method: 'GET', url: `/api/v1/articles/${value}` })
    expect(detail.statusCode).toBe(404)
    expect((await publicList()).data).toHaveLength(0)
  })

  it('accepts an archived status as text and still lands a draft', async () => {
    // `status` stays in the required-key set, so it is still validated as a word —
    // but which word has no effect on what gets written.
    const response = await importFiles([
      { name: 'archived.md', markdown: markdown(slugOf('says-archived'), { fields: { status: 'archived' } }) },
    ])
    expect(response.statusCode).toBe(200)
    expect(createdArticle(results(response)[0], 'archived.md').article.status).toBe('draft')
  })
})

describe('slug conflicts are reported per file (S3-R10)', () => {
  it('conflicts on the duplicate file while importing the new one beside it', async () => {
    const taken = slugOf('twice')
    const fresh = slugOf('twice-new')

    expect((await importFiles([{ name: 'one.md', markdown: markdown(taken) }])).statusCode).toBe(200)

    const second = await importFiles([
      { name: 'one.md', markdown: markdown(taken) },
      { name: 'two.md', markdown: markdown(fresh) },
    ])

    // 200, not 409: the batch *was* accepted and one article did land. The conflict
    // is data inside the result list (design §6).
    expect(second.statusCode).toBe(200)
    expectNoInternalsLeaked(second)

    const body = results(second)
    expect(body).toHaveLength(2)

    const conflicted = conflictResult(body[0], 'one.md')
    expect(conflicted.name).toBe('one.md')
    // The slug the follow-up PATCH addresses, handed back so the client does not
    // have to re-parse markdown to ask "overwrite against what?".
    expect(conflicted.slug).toBe(taken)
    expect(conflicted.message.length).toBeGreaterThan(0)
    expect(createdArticle(body[1], 'two.md').article.slug).toBe(fresh)

    // Exactly one row for the duplicated slug — a conflict never half-wrote.
    expect(await storedRows([taken])).toHaveLength(1)

    // A third import of both conflicts on both and writes nothing new.
    const before = await articleCount()
    const third = await importFiles([
      { name: 'one.md', markdown: markdown(taken) },
      { name: 'two.md', markdown: markdown(fresh) },
    ])
    expect(third.statusCode).toBe(200)
    expect(results(third).map((r) => r.kind)).toEqual(['conflict', 'conflict'])
    expect(await articleCount()).toBe(before)
  })
})

describe('a conflict hands back the draft it would have written (design §3.3)', () => {
  it('carries the parsed fields, and overwriting with them really changes the row', async () => {
    const value = slugOf('overwrite')
    const first = { name: 'v1.md', markdown: markdown(value, { fields: { title: '第一版' }, body: '最初的正文。' }) }
    const second = { name: 'v2.md', markdown: markdown(value, { fields: { title: '第二版' }, body: '改过的正文。' }) }

    expect((await importFiles([first])).statusCode).toBe(200)
    const before = await articleCount()

    const response = await importFiles([second])
    expect(response.statusCode).toBe(200)
    const conflicted = conflictResult(results(response)[0], 'v2.md')

    // `proposed` is what the file *would* have created — parsed server-side, so the
    // page never needs a parser of its own to offer "overwrite".
    expect(conflicted.proposed.title).toBe('第二版')
    // Compared trimmed on purpose: the parser keeps the body's trailing newline
    // (`parseFixture` strips only a leading one), so the exact bytes here are the
    // fixture's shape, not the thing under test. What matters is that the very
    // value handed back is the value that lands — asserted on the next round below.
    expect(conflicted.proposed.content.trim()).toBe('改过的正文。')
    expect(conflicted.proposed.slug).toBe(value)
    // Same structural guarantee as the request path: a carried draft has no way to
    // say "published", so an overwrite cannot smuggle a status in.
    expect(conflicted.proposed).not.toHaveProperty('status')

    // The point of returning it: one PATCH with that body overwrites, no duplicate.
    const overwrite = await app.inject({
      method: 'PATCH',
      url: `/api/v1/articles/${value}`,
      headers: adminHeaders(),
      payload: conflicted.proposed,
    })
    expect(overwrite.statusCode).toBe(200)
    expect(overwrite.json().title).toBe('第二版')
    // Byte-for-byte what `proposed` carried is what the row now holds — this is the
    // one assertion that proves the round trip does not silently reshape the text.
    expect(overwrite.json().content).toBe(conflicted.proposed.content)

    expect(await articleCount()).toBe(before)
    const rows = await storedRows([value])
    expect(rows).toHaveLength(1)
    // Overwrite still does not publish: PATCH here carried no status, and the row
    // was a draft before, so it must still be invisible publicly.
    expect(rows[0]!.status).toBe('draft')
  })
})

describe('size limits', () => {
  it('refuses one file over the per-file byte cap with the DTO message, writing nothing', async () => {
    const before = await articleCount()
    const tooBig = markdown(slugOf('oversized'), { body: padTo(IMPORT_MAX_MARKDOWN_BYTES + 1024) })

    const response = await importFiles([
      { name: 'small.md', markdown: markdown(slugOf('alongside-oversized')) },
      { name: 'huge.md', markdown: tooBig },
    ])

    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe(ERROR_CODES.badRequest)
    // The *useful* message, from the DTO rather than the framework: this body sits
    // far below the route's bodyLimit, so Zod is the one that gets to answer.
    expect(errorMessage(response)).toContain('markdown exceeds')
    expectNoInternalsLeaked(response)

    expect(await articleCount()).toBe(before)
    expect(await storedRows([slugOf('alongside-oversized')])).toHaveLength(0)
  })

  it(`refuses a batch of ${IMPORT_MAX_FILES + 1} files and writes nothing`, async () => {
    const before = await articleCount()
    const files = Array.from({ length: IMPORT_MAX_FILES + 1 }, (_unused, index) => ({
      name: `many-${index}.md`,
      markdown: markdown(slugOf(`many-${index}`)),
    }))

    const response = await importFiles(files)
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe(ERROR_CODES.badRequest)
    expect(errorMessage(response)).toContain(`${IMPORT_MAX_FILES} files`)
    expectNoInternalsLeaked(response)

    expect(await articleCount()).toBe(before)
  })

  it('refuses a batch whose files are individually legal but collectively over the cap', async () => {
    // Each file sits under the per-file ceiling, so only the batch rule can catch
    // this — the rule that exists for "a hand resting on the file picker".
    const before = await articleCount()
    const each = Math.ceil(IMPORT_MAX_TOTAL_MARKDOWN_BYTES / IMPORT_MAX_FILES) + 6000
    expect(each).toBeLessThan(IMPORT_MAX_MARKDOWN_BYTES)

    const files = Array.from({ length: IMPORT_MAX_FILES }, (_unused, index) => ({
      name: `bulk-${index}.md`,
      markdown: markdown(slugOf(`bulk-${index}`), { body: padTo(each) }),
    }))

    const response = await importFiles(files)
    expect(response.statusCode).toBe(400)
    expect(errorMessage(response)).toContain('batch exceeds')
    expectNoInternalsLeaked(response)

    expect(await articleCount()).toBe(before)
  })

  it('rejects an over-long or path-shaped file name, writing nothing', async () => {
    const before = await articleCount()

    const longName = await importFiles([
      { name: `${'n'.repeat(IMPORT_MAX_NAME_LENGTH + 1)}.md`, markdown: markdown(slugOf('long-name')) },
    ])
    expect(longName.statusCode).toBe(400)
    expect(longName.json().error.code).toBe(ERROR_CODES.badRequest)

    for (const name of ['../etc/passwd.md', 'dir/secrets.md', 'back\\slash.md', 'tab\tname.md']) {
      const response = await importFiles([{ name, markdown: markdown(slugOf('hostile-name')) }])
      expect(response.statusCode, name).toBe(400)
      expectNoInternalsLeaked(response)
    }

    expect(await articleCount()).toBe(before)
  })

  it('answers 413 PAYLOAD_TOO_LARGE for a body above the route bodyLimit, with no framework code', async () => {
    // Fastify enforces `bodyLimit` while collecting the body, before the schema
    // runs, so this is the one size case the DTO cannot speak for. What the test
    // actually proves is the error handler's translation: the thrown error carries
    // `code: FST_ERR_CTP_BODY_TOO_LARGE`, and `CODE_BY_STATUS[413]` must replace it
    // (conventions §2 — scrub the code, not just the message).
    const before = await articleCount()
    const body = markdown(slugOf('beyond-limit'), { body: padTo(IMPORT_BODY_LIMIT_BYTES + 64 * 1024) })

    const response = await importFiles([{ name: 'enormous.md', markdown: body }])

    expect(response.statusCode).toBe(413)
    expect(response.json().error.code).toBe(ERROR_CODES.payloadTooLarge)
    expect(response.body).not.toContain('FST_ERR')
    expectNoInternalsLeaked(response)

    expect(await articleCount()).toBe(before)
  })

  it('keeps every other endpoint on Fastify’s default bodyLimit', async () => {
    // The import route's larger ceiling is route-scoped. Proved by contrast: the
    // same shape of oversized payload against `POST /api/v1/articles` is refused
    // under the 1 MiB default rather than accepted, so nothing else on the API
    // started swallowing big bodies because one endpoint needed them.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/articles',
      headers: adminHeaders(),
      payload: {
        slug: slugOf('global-limit'),
        title: 'G',
        excerpt: 'e',
        content: padTo(2 * 1024 * 1024),
        category: CATEGORY,
        tags: [],
      },
    })

    expect(response.statusCode).toBe(413)
    expect(response.json().error.code).toBe(ERROR_CODES.payloadTooLarge)
    expect(response.body).not.toContain('FST_ERR')
    expect(await storedRows([slugOf('global-limit')])).toHaveLength(0)
  })
})

describe('import reuses the create path', () => {
  it('stores a hostile-but-legal file name as text only, with the table intact', async () => {
    // `name` is attacker-controlled and is echoed back in results and messages.
    // It must never be concatenated into SQL (the repository binds values) nor
    // treated as a path (nothing here touches the filesystem).
    const value = slugOf('sql-name')
    const name = `Robert'); drop table articles;--.md`
    const before = await articleCount()

    const response = await importFiles([{ name, markdown: markdown(value) }])
    expect(response.statusCode).toBe(200)
    expect(results(response)[0]?.name).toBe(name)
    expect(await storedRows([value])).toHaveLength(1)
    expect(await articleCount()).toBe(before + 1)

    // The table is still there and still queryable — the proof that nothing was
    // executed, not just that the request returned.
    expect(await articleCount()).toBeGreaterThan(0)
  })

  it('refuses an empty or missing file list', async () => {
    const before = await articleCount()

    const empty = await importFiles([])
    expect(empty.statusCode).toBe(400)
    expect(empty.json().error.code).toBe(ERROR_CODES.badRequest)

    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/articles/import',
      headers: adminHeaders(),
      payload: {},
    })
    expect(missing.statusCode).toBe(400)

    expect(await articleCount()).toBe(before)
  })
})

describe('import ordering, proved at the call boundary', () => {
  /**
   * A repository stand-in (`as never` is the accepted cost of substituting for a
   * `Pool` — conventions §4) for the two properties the HTTP suite can only show
   * indirectly: that nothing is *attempted* before every file has parsed, and that
   * a failure which is not a slug conflict is not dressed up as one.
   *
   * The row-count assertions above cover the same ground against real Postgres;
   * this is the deterministic half — a live database cannot be made to answer
   * "permission denied" on an insert, but a double can.
   */
  function fakeRepository(inserts: string[], failWith?: Error) {
    return {
      insertDraft: async (input: { slug: string }) => {
        if (failWith !== undefined) throw failWith
        inserts.push(input.slug)
        return null
      },
    } as never
  }

  it('attempts no insert at all when a later file fails to parse', async () => {
    const inserts: string[] = []
    const service = new ArticleService(fakeRepository(inserts))

    await expect(
      service.importAll([
        { name: 'good.md', markdown: markdown(slugOf('double-good')) },
        { name: 'bad.md', markdown: markdown(slugOf('double-bad'), { omit: ['status'] }) },
        { name: 'good-2.md', markdown: markdown(slugOf('double-good-2')) },
      ]),
    ).rejects.toBeInstanceOf(ApiError)

    // Not "the count did not change" — the insert was never *called*, so no row and
    // no transaction of any kind was opened for the two files that came first.
    expect(inserts).toEqual([])
  })

  it('rethrows a create-path failure that is not a slug conflict', async () => {
    // Were the catch written as "any error is a conflict", a database outage or a
    // permission failure would come back as a 200 whose rows say `conflict` — a
    // business outcome invented out of an infrastructure fault. Only SLUG_CONFLICT
    // is allowed to become a per-file result.
    const boom = new ApiError(ERROR_CODES.forbidden, 'the create path refused', 403)
    const inserts: string[] = []
    const service = new ArticleService(fakeRepository(inserts, boom))

    await expect(
      service.importAll([{ name: 'one.md', markdown: markdown(slugOf('rethrow')) }]),
    ).rejects.toBe(boom)
  })
})

describe('import authorisation — reverse tests (S3-R11)', () => {
  const payload = [{ name: 'authz.md', markdown: markdown(slugOf('authz-blocked')) }]

  it('refuses a request with no credentials at all: 401', async () => {
    const before = await articleCount()
    const response = await importFiles(payload, {})
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe(ERROR_CODES.unauthorized)
    expect(await articleCount()).toBe(before)
  })

  it('refuses an authenticated non-admin: 403', async () => {
    const before = await articleCount()
    const response = await importFiles(payload, {
      authorization: `Bearer ${tokenFor(users.plain)}`,
      'x-requested-with': 'portal',
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe(ERROR_CODES.forbidden)
    expect(await articleCount()).toBe(before)
  })

  it('refuses an admin without the CSRF header: 403 CSRF_CHECK_FAILED', async () => {
    // `requireAdmin` first, then the header: an authorised-but-headerless call still
    // stops at 403 rather than writing (design §5 — CSRF covers every write verb).
    const before = await articleCount()
    const response = await importFiles(payload, {
      authorization: `Bearer ${tokenFor(users.admin)}`,
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe(ERROR_CODES.csrfCheckFailed)
    expect(await articleCount()).toBe(before)
    expect(await storedRows([slugOf('authz-blocked')])).toHaveLength(0)
  })
})
