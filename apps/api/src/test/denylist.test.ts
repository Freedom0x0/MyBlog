import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { loadConfig } from '../config/index.js'
import { generateJti } from '../lib/tokens.js'

/**
 * Integration against real Redis. The property under test is a TTL behaving as a
 * safety boundary, which a stub would only restate as a mock expectation.
 */
let app: FastifyInstance

beforeAll(async () => {
  if (process.env.DATABASE_URL === undefined || process.env.REDIS_URL === undefined) {
    throw new Error('DATABASE_URL and REDIS_URL are required for denylist tests')
  }
  app = await buildApp({ config: loadConfig() })

  /**
   * The plugin deliberately does not await the first connect, so buildApp can
   * return while the client is still dialling. Commands then fail immediately
   * rather than queueing — that is `disableOfflineQueue` working as designed, and
   * `/ready` reporting degraded during the gap is also correct.
   *
   * So the test waits for the state it depends on. Restoring a blocking connect to
   * make this deterministic would trade a real outage-resilience property for
   * test convenience.
   */
  const deadline = Date.now() + 5_000
  while (!app.redis.isReady && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
})

afterAll(async () => {
  await app?.close()
})

describe('access token denylist', () => {
  it('reports an unknown id as live', async () => {
    await expect(app.denylist.isRevoked(generateJti())).resolves.toBe(false)
  })

  it('reports a revoked id as dead', async () => {
    const jti = generateJti()

    await app.denylist.revoke(jti, 60)

    await expect(app.denylist.isRevoked(jti)).resolves.toBe(true)
  })

  /**
   * The reason entries are not permanent.
   *
   * A denylist that outlives its tokens grows forever while protecting nothing:
   * once a token has expired on its own, remembering it buys nothing. This is
   * also what keeps the Redis footprint bounded by "logouts in the last 15
   * minutes" instead of "all logouts ever".
   */
  it('forgets the entry once the token would have expired anyway', async () => {
    const jti = generateJti()

    await app.denylist.revoke(jti, 1)
    await expect(app.denylist.isRevoked(jti)).resolves.toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 1_400))

    await expect(app.denylist.isRevoked(jti)).resolves.toBe(false)
  })

  it('revoking twice does not extend the deadline', async () => {
    // NX matters: a re-revoke that reset the TTL would turn a bounded record into
    // an unbounded one for a token an attacker keeps presenting.
    const jti = generateJti()

    await app.denylist.revoke(jti, 2)
    await app.denylist.revoke(jti, 600)

    // A raw sendCommand with a guessed shape broke the RESP stream and took the
    // socket down; node-redis exposes ttl directly.
    expect(await app.redis.ttl(`deny:${jti}`)).toBeLessThanOrEqual(2)

    await app.redis.del(`deny:${jti}`)
  })

  it('floors a non-positive ttl so a key is never left forever', async () => {
    const jti = generateJti()

    await app.denylist.revoke(jti, 0)

    expect(await app.redis.ttl(`deny:${jti}`)).toBeGreaterThan(0)

    await app.redis.del(`deny:${jti}`)
  })
})
