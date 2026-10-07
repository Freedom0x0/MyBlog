import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import type { Config } from '../config/index.js'
import { denylistPlugin } from './denylist.js'
import { authPlugin, requireAuth } from './auth.js'
import { errorHandlerPlugin } from './errorHandler.js'
import { requireAnonRateLimit, requireWriteRateLimit } from './rateLimit.js'

/**
 * The guards, against a Redis that refuses to answer.
 *
 * No container is touched to produce an outage here — conventions.md §4 says
 * exactly this: substitute the dependency so the failure that is awkward to
 * arrange against a live service becomes an ordinary test. What is under test is
 * the *scoping* of the fail-open, which is the part with a security consequence.
 */

// Only the keys these two guards read. A unit test that pulled the real
// `loadConfig()` would depend on the environment for a number it is asserting on,
// so the ceiling under test is written here instead.
const config = {
  JWT_SECRET: 'u'.repeat(43),
  ACCESS_TOKEN_TTL_SECONDS: 900,
  RATE_LIMIT_WRITE_PER_MINUTE: 2,
  RATE_LIMIT_ANON_PER_MINUTE: 2,
} as Config

/**
 * Only the commands these two guards can reach.
 *
 * Shaped loosely on purpose: the point of the double is that it *fails*, so the
 * value side of each signature is irrelevant and `unknown` keeps both the
 * all-rejecting and the partially-rejecting variants assignable without a cast.
 */
interface FailingRedis {
  set(...args: unknown[]): Promise<unknown>
  incr(...args: unknown[]): Promise<unknown>
  exists(...args: unknown[]): Promise<unknown>
  ttl(...args: unknown[]): Promise<unknown>
  del(...args: unknown[]): Promise<unknown>
}

/** A client whose every command rejects, the way node-redis does with
 *  `disableOfflineQueue: true` while it is disconnected. */
function rejecting(): FailingRedis {
  const fail = async (): Promise<never> => {
    throw new Error('Connection is closed')
  }

  return { set: fail, incr: fail, exists: fail, ttl: fail, del: fail }
}

/**
 * The same outage, but confined to the two commands the counter issues.
 *
 * This is the shape that lets the write route be tested at all: with every command
 * failing, `requireAuth` dies at the denylist before the limiter is reached, so the
 * run below would be measuring auth rather than the limiter. Answering `exists`
 * while rejecting `set`/`incr` isolates the fail-open to the one component that
 * owns it.
 */
const limiterOnlyDown = (): FailingRedis => ({
  ...rejecting(),
  // Not revoked: the token is live as far as the denylist is concerned, so the
  // only thing failing on this request is the counter.
  exists: async () => 0,
})

async function buildApp(
  redis: FailingRedis,
  logs: string[],
): Promise<{ app: FastifyInstance; token: string }> {
  const app = Fastify({
    // A real pino stream at `warn`, because "we logged a warn" is the assertion —
    // `logger: false` would make every fail-open invisible to the test.
    logger: { level: 'warn', stream: { write: (chunk: string) => void logs.push(chunk) } },
  })

  app.decorate('config', config)
  // `as never` is this repo's accepted cost of substituting for a real client;
  // see conventions.md §4.
  app.decorate('redis', redis as never)

  await app.register(denylistPlugin)
  await app.register(authPlugin, { config })
  await app.register(errorHandlerPlugin)

  // An anonymous door with the IP bucket, exactly as `/auth/github/start` has it.
  app.get('/anon', { onRequest: [requireAnonRateLimit] }, async () => ({ ok: true }))

  // A write door with the identity bucket. `requireAuth` first, because
  // `requireWriteRateLimit` needs `request.auth` — the same ordering the real
  // routes use, and the reason a missing identity is a wiring bug rather than a
  // runtime state.
  app.get('/write', { onRequest: [requireAuth, requireWriteRateLimit] }, async () => ({ ok: true }))

  const token = app.signAccessToken({ sub: 'user-under-test', jti: 'jti-under-test' })

  return { app, token }
}

describe('rate-limit guards with Redis unavailable (S6-R6)', () => {
  it('lets an anonymous request through and logs one warn', async () => {
    const logs: string[] = []
    const { app } = await buildApp(rejecting(), logs)

    const response = await app.inject({ method: 'GET', url: '/anon' })

    expect(response.statusCode).toBe(200)
    // The warn exists because an outage that limits nothing must still be loud:
    // silently disabling the shield is how it stays disabled for a month.
    const warns = logs.filter((line) => line.includes('rate limiter unavailable'))
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('Connection is closed')

    await app.close()
  })

  it('lets an authenticated write through and logs one warn', async () => {
    const logs: string[] = []
    const { app, token } = await buildApp(limiterOnlyDown(), logs)

    const response = await app.inject({
      method: 'GET',
      url: '/write',
      headers: { authorization: `Bearer ${token}` },
    })

    // 200 here is the whole point: a Redis wobble on the counter must not take the
    // admin UI down, and the admin reaching this route already proved who they are.
    expect(response.statusCode).toBe(200)
    expect(logs.filter((line) => line.includes('rate limiter unavailable'))).toHaveLength(1)

    await app.close()
  })

  /**
   * The half that decides whether this change is safe.
   *
   * `requireAuth` reads the denylist, and the denylist reads the *same* Redis that
   * just failed the limiter. If the fail-open had been written around the wrong
   * call — or pushed up into a shared helper — a revoked token would sail through
   * whenever Redis blinked, which converts a performance feature into an auth
   * bypass. So the assertion is not "401 vs 200" but "not 200": the request must
   * be refused, and refused by an error that says nothing about rate limiting.
   */
  it('does NOT make the denylist fail-open: a live token is still refused', async () => {
    const logs: string[] = []
    const { app, token } = await buildApp(rejecting(), logs)

    const response = await app.inject({
      method: 'GET',
      url: '/write',
      headers: { authorization: `Bearer ${token}` },
    })

    // `requireAuth` runs before the limiter, so it is the one that meets the dead
    // Redis first — and it propagates. 500 + INTERNAL_ERROR is the pre-existing
    // behaviour, unchanged by S6; whatever it is, it is not a 200.
    expect(response.statusCode).not.toBe(200)
    expect(response.statusCode).toBe(500)
    expect(response.json().error.code).toBe('INTERNAL_ERROR')

    // And the limiter's warn must be the one thing NOT on this request's log: the
    // refusal came from auth, and mislabelling it would send whoever reads the log
    // looking at the wrong subsystem.
    expect(logs.filter((line) => line.includes('rate limiter unavailable'))).toHaveLength(0)

    await app.close()
  })

  it('names the request that reached a write guard with no identity, and lets it by', async () => {
    // `requireWriteRateLimit` cannot bucket what it cannot identify, and falling
    // back to IP would recreate the collapsed-bucket bug S6-R2 exists to avoid. So
    // it declines to limit and says so at `error`, not `warn`: this is a route
    // wired in the wrong order, reachable only by a mistake in an `onRequest`
    // array — never by a caller.
    const logs: string[] = []
    const { app } = await buildApp(rejecting(), logs)

    app.get('/miswired', { onRequest: [requireWriteRateLimit] }, async () => ({ ok: true }))

    const response = await app.inject({ method: 'GET', url: '/miswired' })

    expect(response.statusCode).toBe(200)
    expect(logs.filter((line) => line.includes('must be attached after an auth guard'))).toHaveLength(1)

    await app.close()
  })
})
