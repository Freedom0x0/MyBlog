import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { errorHandlerPlugin } from './errorHandler.js'
import { ApiError } from '../errors.js'

async function buildTestApp() {
  // Mirrors the request-id options app.ts sets, so propagation behaviour is
  // locked in here rather than only verified by hand.
  const app = Fastify({
    logger: false,
    requestIdHeader: 'x-request-id',
    genReqId: () => 'generated-id',
  })

  await app.register(errorHandlerPlugin)

  app.get('/boom', async () => {
    throw new Error('connection string postgres://user:hunter2@db:5432 leaked')
  })

  // Shape of a real driver failure: Postgres reports SQLSTATE in `code`.
  app.get('/driver-error', async () => {
    const error = new Error(
      'duplicate key value violates unique constraint "articles_slug_key"',
    ) as Error & { code: string }
    error.code = '23505'
    throw error
  })

  app.get('/deliberate', async () => {
    throw new ApiError('ARTICLE_NOT_FOUND', 'No article with that slug', 404)
  })

  app.post('/echo', async (request) => request.body)

  return app
}

describe('error handler', () => {
  it('formats 404 in the shared envelope instead of Fastify default', async () => {
    const app = await buildTestApp()

    const response = await app.inject({ method: 'GET', url: '/nope' })
    const body = response.json()

    expect(response.statusCode).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.requestId).toBe('generated-id')

    await app.close()
  })

  it('carries a caller-supplied request id through to the response', async () => {
    // One id spanning the caller's logs, our logs, and the response body is what
    // makes a reported error traceable at all.
    const app = await buildTestApp()

    const response = await app.inject({
      method: 'GET',
      url: '/nope',
      headers: { 'x-request-id': 'trace-from-client' },
    })

    expect(response.json().error.requestId).toBe('trace-from-client')

    await app.close()
  })

  it('never leaks internal error details to the caller on a 5xx', async () => {
    const app = await buildTestApp()

    const response = await app.inject({ method: 'GET', url: '/boom' })
    const body = response.json()

    expect(response.statusCode).toBe(500)
    expect(body.error.code).toBe('INTERNAL_ERROR')
    expect(body.error.message).toBe('Internal server error')

    // The thrown message contained a credential. It must reach the log, never
    // the response — which is why the two are formatted separately.
    expect(JSON.stringify(body)).not.toContain('hunter2')

    await app.close()
  })

  it('does not forward a driver error code on a 5xx', async () => {
    /**
     * The `code` field needs the same scrubbing as `message`. Forwarding it
     * hands the caller a Postgres SQLSTATE, which describes our schema — and
     * makes the public code vocabulary whatever the driver happens to emit.
     *
     * This case is why the previous version of this test was insufficient: it
     * threw a bare `Error`, which has no `code` to leak.
     */
    const app = await buildTestApp()

    const response = await app.inject({ method: 'GET', url: '/driver-error' })
    const body = response.json()

    expect(response.statusCode).toBe(500)
    expect(body.error.code).toBe('INTERNAL_ERROR')
    expect(JSON.stringify(body)).not.toContain('23505')
    expect(JSON.stringify(body)).not.toContain('articles_slug_key')

    await app.close()
  })

  it('does not forward a framework error code on a 4xx', async () => {
    // Fastify reports FST_ERR_CTP_INVALID_JSON_BODY for a malformed body. Its
    // internal naming would otherwise become part of our public contract.
    const app = await buildTestApp()

    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{ this is not json',
    })
    const body = response.json()

    expect(response.statusCode).toBe(400)
    expect(body.error.code).toBe('BAD_REQUEST')
    expect(JSON.stringify(body)).not.toContain('FST_ERR')

    await app.close()
  })

  it('forwards the code of an error we raised deliberately', async () => {
    // The other half of the rule: our own codes must survive, or routes have no
    // way to tell the client what went wrong.
    const app = await buildTestApp()

    const response = await app.inject({ method: 'GET', url: '/deliberate' })
    const body = response.json()

    expect(response.statusCode).toBe(404)
    expect(body.error.code).toBe('ARTICLE_NOT_FOUND')
    expect(body.error.message).toBe('No article with that slug')

    await app.close()
  })
})
