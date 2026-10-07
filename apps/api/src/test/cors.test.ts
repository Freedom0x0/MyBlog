import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { loadConfig } from '../config/index.js'
import { waitForRedis } from './wait-for-redis.js'

/**
 * CORS preflight behaviour (S3 stage D).
 *
 * This surface is invisible to every other test in the suite. `app.inject()` runs
 * the full request lifecycle — hooks, validation, error handling — but there is no
 * browser here to enforce the same-origin policy, so a response the browser would
 * reject looks perfectly fine to `inject`. That is exactly how
 * `@fastify/cors`'s default `methods: 'GET,HEAD,POST'` survived four stages while
 * the write surface had long since grown `PATCH` and `DELETE`: the endpoints were
 * right, the tests were green, and the admin UI's own buttons could not fire.
 *
 * So these tests do not ask "did the endpoint work" — they read the preflight
 * response's own headers, which is the only place this setting is observable.
 */
let app: FastifyInstance
const config = loadConfig()

/** The origin the front end is served from in local development. */
const WEB_ORIGIN = config.PORTAL_WEB_ORIGIN

function preflight(url: string, requestedMethod: string, requestedHeaders: string) {
  return app.inject({
    method: 'OPTIONS',
    url,
    headers: {
      origin: WEB_ORIGIN,
      'access-control-request-method': requestedMethod,
      'access-control-request-headers': requestedHeaders,
    },
  })
}

const CSRF_AND_JSON = 'content-type,x-requested-with'

beforeAll(async () => {
  if (process.env.DATABASE_URL === undefined || process.env.REDIS_URL === undefined) {
    throw new Error('DATABASE_URL and REDIS_URL are required for CORS tests')
  }

  app = await buildApp({ config })
  await waitForRedis(app)
})

afterAll(async () => {
  await app?.close()
})

describe('preflight admits every verb the API actually routes', () => {
  it('allows PATCH on the article write endpoint', async () => {
    const response = await preflight('/api/v1/articles/some-slug', 'PATCH', CSRF_AND_JSON)

    expect(response.statusCode).toBe(204)
    // The assertion is on the list, not on the absence of an error: a 204 with
    // `GET,HEAD,POST` is precisely the failure this guard exists to catch, and it
    // looks like success to anything that only checks the status code.
    expect(allowedMethods(response), 'PATCH missing: the publish button cannot fire').toContain('PATCH')
  })

  it('allows DELETE on the comment and article write endpoints', async () => {
    for (const url of ['/api/v1/comments/some-id', '/api/v1/articles/some-slug']) {
      const response = await preflight(url, 'DELETE', CSRF_AND_JSON)
      expect(allowedMethods(response), `DELETE missing for ${url}`).toContain('DELETE')
    }
  })

  it('allows the two headers a write request genuinely carries', async () => {
    // `x-requested-with` is what `requireCsrfHeader` demands and `content-type` is
    // what a JSON body needs. Either one refused at preflight means the browser
    // never sends the real request, so the header the server requires is the very
    // thing that blocks reaching the server.
    const response = await preflight('/api/v1/articles', 'POST', CSRF_AND_JSON)
    const allowed = allowedHeaders(response).toLowerCase()

    expect(allowed).toContain('content-type')
    expect(allowed).toContain('x-requested-with')
  })

  it('keeps GET, HEAD and POST admitted, which were never the problem', async () => {
    const response = await preflight('/api/v1/articles/some-slug', 'PATCH', CSRF_AND_JSON)
    const allowed = allowedMethods(response)

    // Control for the two assertions above: a `methods` list typed as
    // `['PATCH','DELETE']` would satisfy those while breaking every read the site
    // performs. The default was a superset of what broke, so the fix must stay a
    // superset of the default.
    expect(allowed).toContain('GET')
    expect(allowed).toContain('POST')
  })
})

describe('preflight answers for the configured origin, not the caller', () => {
  it('names PORTAL_WEB_ORIGIN regardless of who asked', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/articles',
      headers: {
        origin: 'http://evil.example',
        'access-control-request-method': 'PATCH',
      },
    })

    /**
     * Recorded because it reads backwards at first glance. `@fastify/cors` echoes
     * the *configured* value rather than the request's `Origin` when the origin is
     * a plain string, so an unrelated caller receives an allow-origin naming a
     * site it is not — and the browser then blocks it, which is the correct
     * outcome. The server never becomes less strict as traffic varies.
     *
     * What this pins down is the corollary the front end has to respect: the page
     * must be served from exactly this origin. Opening the dev server at
     * `http://127.0.0.1:5175` while the config says `http://localhost:5175` makes
     * the echo mismatch the page and every request fails, reads included.
     */
    expect(response.headers['access-control-allow-origin']).toBe(WEB_ORIGIN)
    expect(response.headers['access-control-allow-origin']).not.toBe('http://evil.example')
  })
})

function allowedMethods(response: { headers: Record<string, unknown> }): string[] {
  return splitHeader(response.headers['access-control-allow-methods'])
}

function allowedHeaders(response: { headers: Record<string, unknown> }): string {
  return String(response.headers['access-control-allow-headers'] ?? '')
}

function splitHeader(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim().toUpperCase())
}
