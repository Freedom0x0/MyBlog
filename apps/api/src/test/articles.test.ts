import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { ArticlePage, ArticleDetail, ErrorCode } from 'shared'
import { buildApp } from '../app.js'
import { loadConfig } from '../config/index.js'

/**
 * Integration: real Fastify, real Postgres, the seeded fixtures.
 *
 * These exercise the whole stack — validation, the error handler, repositories —
 * so they need the database. `app.inject()` still avoids binding a port.
 *
 * Redis is deliberately NOT required: read paths never touch it, and the client
 * no longer blocks startup when it is unreachable (see plugins/redis.ts), so a
 * CI job with only a Postgres service can run this file.
 */
let app: FastifyInstance

beforeAll(async () => {
  if (process.env.DATABASE_URL === undefined) {
    throw new Error(
      'DATABASE_URL is required for integration tests.\n' +
        '  local: cp apps/api/.env.example apps/api/.env with a reachable Postgres\n' +
        '  CI:    provided by the postgres service container',
    )
  }

  app = await buildApp({ config: loadConfig() })
})

afterAll(async () => {
  await app?.close()
})

async function get<T>(url: string): Promise<{ status: number; body: T }> {
  const response = await app.inject({ method: 'GET', url })
  return { status: response.statusCode, body: response.json() as T }
}

describe('GET /api/v1/articles', () => {
  it('returns a page shaped as the shared contract', async () => {
    const { status, body } = await get<ArticlePage>('/api/v1/articles?limit=2')

    expect(status).toBe(200)
    expect(body.data).toHaveLength(2)
    expect(body.limit).toBe(2)
    expect(body.next).not.toBeNull()

    // camelCase across the boundary, and never the internal primary key.
    const keys = Object.keys(body.data[0]!).sort()
    expect(keys).toEqual(
      ['category', 'coverImage', 'excerpt', 'publishedAt', 'readTime', 'slug', 'tags', 'title'].sort(),
    )
  })

  it('walks every page with no duplicate and no omitted article', async () => {
    const seen: string[] = []
    let cursor: string | undefined

    for (let page = 0; page < 20; page += 1) {
      const url = `/api/v1/articles?limit=2${cursor === undefined ? '' : `&cursor=${cursor}`}`
      const response = await app.inject({ method: 'GET', url })

      // Asserting the status *before* reading the body: without this a 500 surfaced
      // as "body.data is not iterable" and hid the actual database error.
      expect(response.statusCode, `page ${page} of ${url}`).toBe(200)

      const body = response.json() as ArticlePage
      for (const article of body.data) seen.push(article.slug)

      if (body.next === null) break
      cursor = body.next.cursor
    }

    const expected = [
      'backslashes',
      'cjk-emoji',
      'dollar-tags',
      'hostile-quotes',
      'normal-published',
      'oversized',
    ].sort()

    // 6 published fixtures exist; the draft must never surface.
    expect(seen.sort()).toEqual(expected)
    // A duplicated row would show up as the same slug twice in one walk.
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('never exposes drafts through the list', async () => {
    const { body } = await get<ArticlePage>('/api/v1/articles?limit=50')

    expect(body.data.map((a) => a.slug)).not.toContain('draft-unpublished')
  })

  it('rejects an out-of-range limit with the project code, not a framework one', async () => {
    for (const raw of ['0', '-3', 'abc', '51', '1.5']) {
      const response = await app.inject({ method: 'GET', url: `/api/v1/articles?limit=${raw}` })

      expect(response.statusCode, raw).toBe(400)

      const body = response.json() as { error?: { code?: ErrorCode } }
      expect(body.error?.code, raw).toBe('BAD_REQUEST')
      // The public contract must not become Fastify's internal naming.
      expect(response.body).not.toContain('FST_ERR')
    }
  })

  it('rejects a tampered cursor as INVALID_CURSOR, not a 500', async () => {
    const { status, body } = await get<{ error: { code: ErrorCode } }>(
      '/api/v1/articles?cursor=not-a-real-cursor',
    )

    expect(status).toBe(400)
    expect(body.error.code).toBe('INVALID_CURSOR')
  })

  it('filters by tag and by category', async () => {
    const byTag = await get<ArticlePage>('/api/v1/articles?tag=emoji&limit=10')
    expect(byTag.body.data.map((a) => a.slug)).toEqual(['cjk-emoji'])

    const byCategory = await get<ArticlePage>('/api/v1/articles?category=Unicode&limit=10')
    expect(byCategory.body.data.map((a) => a.slug)).toEqual(['cjk-emoji'])

    const nothing = await get<ArticlePage>('/api/v1/articles?tag=no-such-tag&limit=10')
    expect(nothing.body.data).toEqual([])
    expect(nothing.body.next).toBeNull()
  })
})

describe('GET /api/v1/articles/:slug', () => {
  it('returns the full body, byte-for-byte, for the hostile fixtures', async () => {
    // The same guarantee stage B proved at the SQL level, now through the API.
    const { status, body } = await get<ArticleDetail>('/api/v1/articles/oversized')

    expect(status).toBe(200)
    expect(body.content).toContain("const s = 'quote inside'")
    expect(body.content).toContain('C:\\tmp\\x')
    expect(body.content).toContain('🏳️‍🌈')
    expect(Buffer.byteLength(body.content, 'utf8')).toBe(117_669)
  })

  it('returns 404 ARTICLE_NOT_FOUND for an unknown slug', async () => {
    const { status, body } = await get<{ error: { code: ErrorCode } }>(
      '/api/v1/articles/no-such-article',
    )

    expect(status).toBe(404)
    expect(body.error.code).toBe('ARTICLE_NOT_FOUND')
  })

  it('answers 404, not 403, for a draft — existing-but-hidden is still a leak', async () => {
    const { status, body } = await get<{ error: { code: ErrorCode } }>(
      '/api/v1/articles/draft-unpublished',
    )

    expect(status).toBe(404)
    expect(body.error.code).toBe('ARTICLE_NOT_FOUND')
  })
})
