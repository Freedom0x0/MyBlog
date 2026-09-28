import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { CommentList, ErrorCode } from 'shared'
import { buildApp } from '../app.js'
import { loadConfig } from '../config/index.js'

/**
 * Comments are read through an article, so the interesting assertions are about
 * the shared visibility rule and about the shape crossing the boundary — not
 * about counting rows the seed happens to contain.
 */
let app: FastifyInstance

beforeAll(async () => {
  if (process.env.DATABASE_URL === undefined) {
    throw new Error('DATABASE_URL is required for integration tests (see ci.yml postgres service)')
  }
  app = await buildApp({ config: loadConfig() })
})

afterAll(async () => {
  await app?.close()
})

async function get<T>(url: string) {
  const response = await app.inject({ method: 'GET', url })
  return { status: response.statusCode, body: response.json() as T, raw: response.body }
}

describe('GET /api/v1/articles/:slug/comments', () => {
  it('returns a flat list with parentId pointers, oldest first', async () => {
    const { status, body } = await get<CommentList>(
      '/api/v1/articles/normal-published/comments',
    )

    expect(status).toBe(200)
    expect(body.data).toHaveLength(2)

    const [root, reply] = body.data
    expect(root?.parentId).toBeNull()
    // The reply points at the root rather than being nested inside it.
    expect(reply?.parentId).toBe(root?.id)
    expect(body.data.map((c) => c.content)).toEqual([
      '第一层评论，用于验证平铺返回与建树。',
      '这是一条嵌套回复。',
    ])
  })

  it('carries the author through a join, not a stored snapshot', async () => {
    const { body } = await get<CommentList>(
      '/api/v1/articles/normal-published/comments',
    )

    const author = body.data[0]?.author
    expect(author?.login).toBe('reader-bot')
    expect(author?.displayName).toBe('Reader Bot')

    // No denormalised name/avatar columns reach the client.
    expect(body.data[0]).not.toHaveProperty('user_name')
    expect(body.data[0]).not.toHaveProperty('avatar_url')
  })

  it('answers 404 for a draft — the same rule the article endpoint uses', async () => {
    const { status, body, raw } = await get<{ error: { code: ErrorCode } }>(
      '/api/v1/articles/draft-unpublished/comments',
    )

    expect(status).toBe(404)
    expect(body.error.code).toBe('ARTICLE_NOT_FOUND')
    // A draft's comments must not be enumerable even by its own slug.
    expect(raw).not.toContain('第一层评论')
  })

  it('answers 404 for an unknown slug, and an empty list for a published article with none', async () => {
    const missing = await get('/api/v1/articles/no-such-article/comments')
    expect(missing.status).toBe(404)

    const empty = await get<CommentList>('/api/v1/articles/oversized/comments')
    expect(empty.status).toBe(200)
    expect(empty.body.data).toEqual([])
  })

  it('exposes the internal article id but never the snake_case column names', async () => {
    const { body } = await get<CommentList>(
      '/api/v1/articles/normal-published/comments',
    )

    const keys = Object.keys(body.data[0]!).sort()
    expect(keys).toEqual(['articleId', 'author', 'content', 'createdAt', 'id', 'parentId'])
  })
})
