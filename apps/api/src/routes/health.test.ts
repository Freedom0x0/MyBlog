import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { healthRoutes } from './health.js'
// These imports exist for their side effect: each plugin module carries the
// `declare module 'fastify'` block that types `app.db` / `app.redis`. Without
// them this test file would not know those decorators exist.
import '../plugins/db.js'
import '../plugins/redis.js'

interface Doubles {
  dbQuery?: () => Promise<unknown>
  redisPing?: () => Promise<unknown>
}

/**
 * A bare instance with stand-in dependencies, so readiness logic can be tested
 * without Postgres or Redis running. That keeps the suite fast and lets us
 * simulate failures that would be awkward to produce against a real service.
 */
function buildTestApp(doubles: Doubles = {}): FastifyInstance {
  const app = Fastify({ logger: false })

  // Casts are the price of substituting a test double for a Pool / RedisClient.
  app.decorate('db', {
    query: doubles.dbQuery ?? (async () => ({ rows: [{ ok: 1 }] })),
  } as never)

  app.decorate('redis', {
    ping: doubles.redisPing ?? (async () => 'PONG'),
  } as never)

  return app
}

describe('GET /health (liveness)', () => {
  it('stays 200 even when every dependency is unreachable', async () => {
    /**
     * The assertion that matters most in this file. Liveness answers "is the
     * process alive"; if it consulted the database, a database outage would make
     * an orchestrator kill and restart a perfectly healthy process — which does
     * not fix the database, and adds a restart loop on top of the outage.
     */
    const app = buildTestApp({
      dbQuery: async () => {
        throw new Error('postgres is down')
      },
      redisPing: async () => {
        throw new Error('redis is down')
      },
    })
    await app.register(healthRoutes)

    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })

    await app.close()
  })
})

describe('GET /ready (readiness)', () => {
  it('is 200 with each dependency reported when everything answers', async () => {
    const app = buildTestApp()
    await app.register(healthRoutes)

    const response = await app.inject({ method: 'GET', url: '/ready' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      status: 'ok',
      checks: { postgres: 'ok', redis: 'ok' },
    })

    await app.close()
  })

  it('is 503 and names the dependency that failed', async () => {
    const app = buildTestApp({
      dbQuery: async () => {
        throw new Error('connection refused')
      },
    })
    await app.register(healthRoutes)

    const response = await app.inject({ method: 'GET', url: '/ready' })
    const body = response.json()

    // 503 is the signal that makes a load balancer stop routing here. A 200 with
    // a failed body would keep sending traffic to an instance that cannot serve.
    expect(response.statusCode).toBe(503)
    expect(body.status).toBe('degraded')
    expect(body.checks.postgres).toBe('failed')

    // The healthy dependency is still reported. Short-circuiting on the first
    // failure would hide which of the two is actually broken.
    expect(body.checks.redis).toBe('ok')

    await app.close()
  })

  it('is 503 when only Redis fails', async () => {
    const app = buildTestApp({
      redisPing: async () => {
        throw new Error('connection refused')
      },
    })
    await app.register(healthRoutes)

    const response = await app.inject({ method: 'GET', url: '/ready' })

    expect(response.statusCode).toBe(503)
    expect(response.json().checks).toEqual({ postgres: 'ok', redis: 'failed' })

    await app.close()
  })
})
