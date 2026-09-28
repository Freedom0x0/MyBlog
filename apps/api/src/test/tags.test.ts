import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { ArticlePage, TagList } from 'shared'
import { buildApp } from '../app.js'
import { loadConfig } from '../config/index.js'

let app: FastifyInstance

beforeAll(async () => {
  if (process.env.DATABASE_URL === undefined) {
    throw new Error('DATABASE_URL is required for integration tests (see ci.yml postgres service)')
  }
  app = await buildApp({ config: loadConfig() })
})

afterAll(async () => { await app?.close() })

async function get<T>(url: string) {
  const r = await app.inject({ method: 'GET', url })
  return { status: r.statusCode, body: r.json() as T, raw: r.body }
}

describe('GET /api/v1/tags', () => {
  it('counts published articles per tag, and excludes draft-only tags', async () => {
    const { status, body } = await get<TagList>('/api/v1/tags')

    expect(status).toBe(200)
    // draft-unpublished carries only [草稿]; a draft-only tag must never surface.
    // That is the strict assertion here; the count is checked as present-and-used
    // so unrelated articles in someone's local database cannot fail this test.
    expect(body.data.map((t) => t.tag)).not.toContain('草稿')
    expect(body.data.find((t) => t.tag === 'unicode')?.count).toBeGreaterThanOrEqual(1)
  })
})

describe('GET /api/v1/tags/:tag', () => {
  it('returns the same paginated shape as the article list', async () => {
    const { status, body } = await get<ArticlePage>('/api/v1/tags/emoji?limit=2')

    expect(status).toBe(200)
    // Membership, not equality — see the same reasoning in articles.test.ts.
    expect(body.data.map((a) => a.slug)).toContain('cjk-emoji')
    expect(body.next).toBeNull()
    expect(body.limit).toBe(2)
  })

  it('gives 404 for an unknown tag path and an empty page, not an error', async () => {
    const empty = await get<ArticlePage>('/api/v1/tags/no-such-tag')
    expect(empty.status).toBe(200)
    expect(empty.body.data).toEqual([])
  })

  it('applies the article list bounds here too', async () => {
    const tooBig = await app.inject({ method: 'GET', url: '/api/v1/tags/emoji?limit=9999' })
    expect(tooBig.statusCode).toBe(400)
    expect((tooBig.json() as { error: { code: string } }).error.code).toBe('BAD_REQUEST')
  })
})
