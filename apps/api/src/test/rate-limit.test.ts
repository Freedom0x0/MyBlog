import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { ERROR_CODES } from 'shared'
import { buildApp } from '../app.js'
import { loadConfig } from '../config/index.js'
import { bucketWindow, RATE_LIMIT_PREFIX, windowKey } from '../lib/rateLimit.js'
import { generateJti } from '../lib/tokens.js'
import { waitForRedis } from './wait-for-redis.js'

/**
 * Rate limiting against real Redis and real Postgres.
 *
 * Both are required for different reasons, and neither is decoration:
 *
 * - **Redis** is where the one assertion that cannot be made any other way lives.
 *   S6-R1's claim is about the *state a crashed process leaves behind*, which is
 *   only observable as a TTL on a key a real server holds. A double can echo back
 *   whatever expiry it was handed; it cannot be the thing that would outlive the
 *   window if the order were wrong. (The command order itself is pinned in
 *   `lib/rateLimit.test.ts`, and the fail-open is in `plugins/rateLimit.test.ts`
 *   — both deliberately *without* containers, because a stub is the only way to
 *   make Redis fail on demand.)
 * - **Postgres** is because the write routes being counted have to actually
 *   succeed: a 429 that fires on the way to a 500 proves nothing about ordering.
 *
 * Test hygiene: every bucket this file touches is deleted by name before the run it
 * belongs to, and every `rl:*` key is swept in `afterAll`. Without that, a re-run
 * inside the same minute would inherit the previous run's counter and fail on the
 * 60/61 boundary for a reason that has nothing to do with the code.
 */

const WINDOW = 60

let app: FastifyInstance
const config = loadConfig()

/** Unique per run, so no slug or user id can collide with a parallel or earlier run. */
const run = randomUUID().slice(0, 8)
const slug = `rl-${run}-target`
const createdSlugs: string[] = []

const ids: { a: string; b: string } = { a: '', b: '' }

function headersFor(userId: string): Record<string, string> {
  return {
    authorization: `Bearer ${app.signAccessToken({ sub: userId, jti: generateJti() })}`,
    'x-requested-with': 'portal',
  }
}

function patchTarget(userId: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/articles/${slug}`,
    headers: headersFor(userId),
    payload: { title: `probe ${run}` },
  })
}

/**
 * The bucket key for an identity, as the guard computes it.
 *
 * Rebuilt here rather than captured because the window index moves with the clock;
 * a key held across a minute boundary would be for a window that has closed.
 */
const writeKey = (userId: string): string => windowKey('write', userId, WINDOW)
const anonKey = (ip: string): string => windowKey('anon', ip, WINDOW)

/** Zeroes one bucket so the run that follows counts from a known nothing. */
async function resetBucket(key: string): Promise<void> {
  await app.redis.del(key)
}

async function bucketCount(key: string): Promise<number> {
  const raw = await app.redis.get(key)
  return raw === null ? 0 : Number(raw)
}

/**
 * Runs a sequence of requests, and re-runs it if the minute rolled over inside it.
 *
 * This is not a flake suppressor, it is the price of a fixed window keyed on the
 * epoch minute: a run that straddles a boundary legitimately changes buckets
 * halfway through, and the 61st request would then correctly succeed. So the
 * window index is checked *before* any assertion runs — `body` only performs
 * requests and returns what it saw, and the expectations live in the caller.
 * Getting that order wrong would mean a real defect throwing inside `body`, being
 * mistaken for a rollover, and being retried three times into a confusing error.
 *
 * Three attempts, then it fails loudly rather than looping: three consecutive
 * rollovers would mean the sequence is longer than a minute, which is its own bug.
 */
async function measure<T>(body: (attempt: number) => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const windowBefore = bucketWindow(WINDOW).index
    const result = await body(attempt)

    if (bucketWindow(WINDOW).index === windowBefore) return result
  }

  throw new Error(`the minute boundary moved on three consecutive runs — the sequence is over ${WINDOW}s long`)
}

/** TEST-NET-3 (RFC 5737): reserved for exactly this, and never a real host. */
const IP_ONE = '203.0.113.61'
const IP_TWO = '203.0.113.62'

/**
 * `oauth_state:` keys this file causes to be written.
 *
 * Every successful `start` mints one (600 s TTL). They are not the residue this
 * file is *required* to collect — `rl:*` is — but a test that can name the keys it
 * created has no business leaving them for the box to expire on its own, and the
 * redirect it got back contains the state value verbatim.
 */
const createdStates: string[] = []

function startFrom(ip: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url: '/api/v1/auth/github/start', headers: { 'x-forwarded-for': ip } })
}

/**
 * Records the state value a 302 handed back.
 *
 * Fastify sends one header value as a string and several as an array, so
 * `Location` has to be narrowed before anything can parse it.
 */
function noteState(response: LightMyRequestResponse): void {
  if (response.statusCode !== 302) return

  const location = response.headers.location
  if (typeof location !== 'string') return

  const state = new URL(location).searchParams.get('state')
  if (state !== null) createdStates.push(state)
}

beforeAll(async () => {
  if (process.env.DATABASE_URL === undefined || process.env.REDIS_URL === undefined) {
    throw new Error('DATABASE_URL and REDIS_URL are required for rate limit tests')
  }

  app = await buildApp({ config })
  await waitForRedis(app)

  const inserted = await app.db.query<{ id: string; github_login: string }>(
    `insert into users (github_login, display_name, is_admin)
       values ($1, 'RL Admin A', true), ($2, 'RL Admin B', true)
       returning id, github_login`,
    [`rl-a-${run}`, `rl-b-${run}`],
  )
  for (const row of inserted.rows) {
    if (row.github_login === `rl-a-${run}`) ids.a = row.id
    else ids.b = row.id
  }

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/articles',
    headers: headersFor(ids.a),
    payload: { slug, title: 'Rate limit target', excerpt: 'e', content: 'c', category: 'RL', tags: [] },
  })
  if (created.statusCode !== 201) {
    throw new Error(`fixture article was not created (${created.statusCode}: ${created.body})`)
  }
  createdSlugs.push(slug)

  // The fixture POST above landed in A's bucket; clear it so the counted runs
  // below start from zero regardless of where in the minute beforeAll finished.
  await resetBucket(writeKey(ids.a))
  await resetBucket(writeKey(ids.b))
})

afterAll(async () => {
  if (app?.db) {
    for (const value of createdSlugs) {
      await app.db.query(`delete from articles where slug = $1`, [value])
    }
    // Prefix on login, not id: an empty id would throw on the uuid cast and hide
    // the real failure, and this also sweeps orphans from a crashed earlier run.
    await app.db.query(`delete from users where github_login like 'rl-%'`)
  }

  if (app?.redis) {
    /**
     * `KEYS`, not `SCAN`.
     *
     * Deliberate and not portable: `KEYS` blocks the server for the length of the
     * sweep, which is fine against a single-tenant dev Redis holding a handful of
     * keys and is an outage-causing pattern in production with a real keyspace.
     * The correct production form is `SCAN` with a `MATCH rl:*` cursor.
     */
    const leftovers = await app.redis.keys(`${RATE_LIMIT_PREFIX}:*`)
    if (leftovers.length > 0) await app.redis.del(leftovers)

    // Named, not swept: these were each returned to us in a redirect, so this file
    // can say exactly which ones it caused.
    if (createdStates.length > 0) {
      await app.redis.del(createdStates.map((state) => `oauth_state:${state}`))
    }
  }

  await app?.close()
})

describe('S6-R1 · the bucket is created with its expiry already attached', () => {
  /**
   * The one test that can see the ordering.
   *
   * A key with no TTL would be for a window that has already closed — the window
   * index is baked into the name — so nothing ever reads it again and nothing ever
   * collects it: an immortal `rl:*` key per crashed gap, forever. `TTL > 0` is the
   * only assertion that distinguishes `SET NX EX` then `INCR` from `INCR` then
   * `EXPIRE` *with a process that survives*, because the intuitive order looks
   * exactly right until the second command does not happen. Swap the two calls in
   * `lib/rateLimit.ts` and this is the line that goes red: after `INCR` the key
   * exists, so the `SET ... NX` is a no-op and no expiry is ever attached (-1).
   */
  it('leaves a live TTL on the counter key it just created', async () => {
    const seen = await measure(async () => {
      const key = writeKey(ids.a)
      await resetBucket(key)
      const status = (await patchTarget(ids.a)).statusCode
      const ttl = await app.redis.ttl(key)
      const count = await bucketCount(key)

      return { key, status, ttl, count }
    })

    expect(seen.status).toBe(200)
    // > 0, not >= 0: -1 means "exists, no expiry" — the exact leak — and -2 means
    // "no such key", which would mean nothing was counted at all.
    expect(seen.ttl).toBeGreaterThan(0)
    expect(seen.count).toBe(1)

    await resetBucket(seen.key)
  })

  /**
   * The other half of S6-R1: a busy window still closes.
   *
   * `NX` is what makes the pair repeatable. Without it, every request inside the
   * window would re-arm the expiry and a caller who keeps coming would never be
   * limited at all — the counter would reach 60 and reset before anyone noticed.
   */
  it('does not re-arm the expiry on a request that arrives inside the window', async () => {
    const seen = await measure(async () => {
      const key = writeKey(ids.a)
      await resetBucket(key)

      const firstStatus = (await patchTarget(ids.a)).statusCode
      const firstTtl = await app.redis.ttl(key)

      const secondStatus = (await patchTarget(ids.a)).statusCode
      const secondTtl = await app.redis.ttl(key)
      const count = await bucketCount(key)

      return { key, firstStatus, firstTtl, secondStatus, secondTtl, count }
    })

    expect(seen.firstStatus).toBe(200)
    expect(seen.secondStatus).toBe(200)
    // Asserted positive as well as bounded, because `-1 <= -1` and `-1 <= 60` are
    // both true: a test that only compares the two readings would pass under the
    // swapped `INCR`-then-`SET NX` order with the key carrying no expiry at all.
    expect(seen.firstTtl).toBeGreaterThan(0)
    expect(seen.firstTtl).toBeLessThanOrEqual(WINDOW)
    // Monotonic, and re-armed under no circumstances: the second request arrived
    // milliseconds later, so the deadline can only have moved down.
    expect(seen.secondTtl).toBeLessThanOrEqual(seen.firstTtl)
    expect(seen.secondTtl).toBeGreaterThan(0)
    expect(seen.count).toBe(2)

    await resetBucket(seen.key)
  })
})

describe('S6-R2 / S6-R5 / S6-R7 · the write surface, bucketed by identity', () => {
  /**
   * 60 through, 61 refused, both sides of the line in one run.
   *
   * Only the rejection is not enough: an off-by-one that stops at 59 and one that
   * stops at 61 both "return 429 eventually". Only the passing side is worse — it
   * would pass the day the limiter is wired to the wrong config key.
   */
  it('allows the 60th write in a window and answers the 61st with 429 + RATE_LIMITED + Retry-After', async () => {
    const seen = await measure(async () => {
      const key = writeKey(ids.a)
      await resetBucket(key)

      const responses: LightMyRequestResponse[] = []
      for (let i = 0; i < 61; i += 1) responses.push(await patchTarget(ids.a))

      return { key, responses, count: await bucketCount(key) }
    })

    expect(seen.responses).toHaveLength(61)

    // Index 58 and 59 are the 59th and 60th requests: the array is 0-based, and the
    // fixture POST that would also have landed in this bucket was cleared first.
    expect(seen.responses[58]!.statusCode).toBe(200)
    expect(seen.responses[59]!.statusCode, 'the 60th write must succeed').toBe(200)

    const limited = seen.responses[60]!
    expect(limited.statusCode, 'the 61st write must be refused').toBe(429)
    expect(limited.json().error.code).toBe(ERROR_CODES.rateLimited)
    // The envelope, not a hand-built body: `requestId` is present only because the
    // throw reached the one global handler, which is the error contract.
    expect(typeof limited.json().error.requestId).toBe('string')

    /**
     * `Retry-After` survives the throw.
     *
     * The guard sets the header on the reply and then throws; Fastify formats the
     * error on that same reply, so the header is only still there if the design
     * works. A 429 without it invites the client to retry immediately, which is
     * the behaviour the limit exists to change.
     */
    const retryAfter = Number(limited.headers['retry-after'])
    expect(Number.isInteger(retryAfter)).toBe(true)
    expect(retryAfter).toBeGreaterThanOrEqual(1)
    expect(retryAfter).toBeLessThanOrEqual(WINDOW)

    expect(seen.count).toBe(61)

    await resetBucket(seen.key)
  })

  /**
   * The reason the bucket is `sub` and not the address (S6-R2).
   *
   * In the deployed topology the previous test's caller and this one's share one
   * IP — the gateway's. Under an IP bucket, A exhausting its quota would have
   * refused B's very next write, and the whole site would be rate-limited by
   * whoever typed the fastest. Identity is what keeps one noisy caller inside its
   * own lane.
   */
  it('does not let one exhausted identity affect another identity in the same window', async () => {
    const seen = await measure(async () => {
      const keyA = writeKey(ids.a)
      const keyB = writeKey(ids.b)
      await Promise.all([resetBucket(keyA), resetBucket(keyB)])

      for (let i = 0; i < 61; i += 1) await patchTarget(ids.a)
      const aRefused = (await patchTarget(ids.a)).statusCode
      // B, in the same minute, against the same target article.
      const bServed = (await patchTarget(ids.b)).statusCode

      return {
        keyA,
        keyB,
        aRefused,
        bServed,
        countA: await bucketCount(keyA),
        countB: await bucketCount(keyB),
      }
    })

    expect(seen.aRefused).toBe(429)
    expect(seen.bServed).toBe(200)
    expect(seen.countB).toBe(1)
    // 62, not 61: the refused request was still counted. That is correct rather
    // than tidy — a refusal that skipped the counter would let the bucket sit at
    // exactly `limit` forever and never re-evaluate against a growing number.
    expect(seen.countA).toBe(62)

    await Promise.all([resetBucket(seen.keyA), resetBucket(seen.keyB)])
  })

  /**
   * One counter across the verbs, because that is what a caller is: an identity
   * doing things, not an identity hitting a URL. A budget that reset per route
   * would allow 60 deletes *and* 60 patches *and* 60 uploads from one person.
   *
   * `POST` then `DELETE` of the same row, and nothing else, so the sequence is
   * repeatable: `measure` re-runs its body when the minute rolls under it, and a
   * body that destroyed the shared fixture would fail on the second attempt for a
   * reason that has nothing to do with the limiter. Hence the per-attempt slug.
   */
  it('counts two different write verbs against one identity budget', async () => {
    const seen = await measure(async (attempt) => {
      const key = writeKey(ids.a)
      await resetBucket(key)

      const probe = `${slug}-probe-${attempt}`
      createdSlugs.push(probe)

      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/articles',
        headers: headersFor(ids.a),
        payload: { slug: probe, title: 'Probe', excerpt: 'e', content: 'c', category: 'RL', tags: [] },
      })

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/v1/articles/${probe}`,
        headers: headersFor(ids.a),
      })

      return { key, created: created.statusCode, deleted: deleted.statusCode, count: await bucketCount(key) }
    })

    expect(seen.created).toBe(201)
    expect(seen.deleted).toBe(204)
    expect(seen.count).toBe(2)

    await resetBucket(seen.key)
  })
})

describe('S6-R3 / S6-R4 · the anonymous start endpoint, bucketed by client IP', () => {
  /**
   * The only proof that `trustProxy` is doing its job.
   *
   * A unit test of the counter cannot see this: it would happily bucket two callers
   * who arrived with different `X-Forwarded-For` headers under the same
   * `127.0.0.1` and the assertion on *counts* would still pass, because the bug is
   * in which key is chosen rather than in how the key is counted. So this test
   * reads the key names out of Redis. If `trustProxy` were removed, both IPs would
   * collapse into the loopback bucket, the 11th request would still be a 429, and
   * the two assertions after it would fail.
   */
  it('keeps two client addresses in two buckets, and does not merge them into the proxy address', async () => {
    const seen = await measure(async () => {
      const keyOne = anonKey(IP_ONE)
      const keyTwo = anonKey(IP_TWO)
      const keyLocal = anonKey('127.0.0.1')
      await Promise.all([resetBucket(keyOne), resetBucket(keyTwo), resetBucket(keyLocal)])

      const statuses: number[] = []
      for (let i = 0; i < 10; i += 1) {
        const response = await startFrom(IP_ONE)
        noteState(response)
        statuses.push(response.statusCode)
      }

      const eleventh = await startFrom(IP_ONE)
      const other = await startFrom(IP_TWO)
      noteState(other)

      return {
        keyOne,
        keyTwo,
        statuses,
        eleventhStatus: eleventh.statusCode,
        eleventhCode: eleventh.json().error.code as string,
        eleventhRetry: eleventh.headers['retry-after'],
        otherAddress: other.statusCode,
        countOne: await bucketCount(keyOne),
        countTwo: await bucketCount(keyTwo),
        countLocal: await bucketCount(keyLocal),
      }
    })

    expect(seen.statuses).toEqual(Array.from({ length: 10 }, () => 302))
    expect(seen.eleventhStatus).toBe(429)
    expect(seen.eleventhCode).toBe(ERROR_CODES.rateLimited)
    expect(Number(seen.eleventhRetry)).toBeGreaterThanOrEqual(1)

    // The other address has sent nothing and is untouched.
    expect(seen.otherAddress).toBe(302)

    // And the naming is what makes it real: two separate keys, each counted, and
    // nothing in the loopback bucket that a missing `trustProxy` would have used.
    expect(seen.countOne).toBe(11)
    expect(seen.countTwo).toBe(1)
    expect(seen.countLocal).toBe(0)

    await Promise.all([resetBucket(seen.keyOne), resetBucket(seen.keyTwo)])
  })

  /**
   * Each start writes an `oauth_state:` key with a 600 s expiry. Left behind that
   * is 10 keys nobody asked for, so the state values are parsed back out of the
   * redirect the endpoint returned and deleted here — the limiter's own sweep in
   * `afterAll` only covers `rl:*`, and this file should not leave residue it can
   * name.
   */
  it('is bounded by its own configured ceiling, which is not the write ceiling', async () => {
    const seen = await measure(async () => {
      const key = anonKey(IP_ONE)
      await resetBucket(key)

      const statuses: number[] = []
      const statesBefore = createdStates.length

      for (let i = 0; i < 12; i += 1) {
        const response = await startFrom(IP_ONE)
        noteState(response)
        statuses.push(response.statusCode)
      }

      return { key, statuses, minted: createdStates.length - statesBefore, count: await bucketCount(key) }
    })

    // Ten served, two refused — the 10-per-minute anon ceiling, and the
    // 60-per-minute write ceiling nowhere in it: separate keys, separate numbers.
    expect(seen.statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 302))
    expect(seen.statuses.slice(10)).toEqual([429, 429])
    expect(seen.count).toBe(12)
    // The count is refused *before* the handler runs, so a throttled start mints
    // no state row: the limit is protecting the work, not just answering the call.
    expect(seen.minted).toBe(10)

    await resetBucket(seen.key)
  })
})

describe('S6-R6 · the limiter does not become an access control', () => {
  /**
   * A refused request is still a *formatted* request, and an uncounted one.
   *
   * The fail-open itself is tested without containers in `plugins/rateLimit.test.ts`
   * — that is the only place a Redis can be made to fail on demand. What belongs
   * here is the neighbouring property: whatever happens to the counter, a caller
   * who is not who they say they are still gets 401, and the limiter never becomes
   * the thing that decides whether a request is allowed to exist.
   *
   * The zero on the bucket is the part worth pinning. The guard sits last in
   * `onRequest`, so a 401 never reaches it and a flood of bad tokens cannot exhaust
   * a real user's quota — an attacker picking random JWTs would otherwise be
   * spending the admin's budget for them.
   */
  it('still answers 401 for a bad token, and never spends quota to do it', async () => {
    const seen = await measure(async () => {
      const key = writeKey(ids.a)
      await resetBucket(key)

      const refused = await app.inject({
        method: 'PATCH',
        url: `/api/v1/articles/${slug}`,
        headers: { authorization: 'Bearer not-a-jwt', 'x-requested-with': 'portal' },
      })

      return { key, status: refused.statusCode, code: refused.json().error.code as string, count: await bucketCount(key) }
    })

    expect(seen.status).toBe(401)
    expect(seen.code).toBe(ERROR_CODES.unauthorized)
    expect(seen.count).toBe(0)

    await resetBucket(seen.key)
  })
})
