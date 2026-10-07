import { describe, expect, it } from 'vitest'
import {
  bucketWindow,
  consumeWindow,
  RATE_LIMIT_PREFIX,
  windowKey,
  type CounterRedis,
} from './rateLimit.js'

/**
 * The counter, against a recording double rather than a container.
 *
 * What is provable here: the arithmetic (which window, how long is left), the
 * boundary (limit-th allowed, limit+1-th refused), the order of the two commands,
 * and the fail-open. What is NOT provable here is the part a double can only
 * parrot — that the expiry really exists on a real key. `test/rate-limit.test.ts`
 * reads `TTL` from the live Redis for that, because the crash-between-steps the
 * ordering guards against is only observable in whatever a real server holds.
 */

/**
 * A double with the two commands the counter uses, plus the two things a test
 * needs to see: the order the calls arrived in, and what the key's expiry was set
 * to. `EX` is recorded rather than applied because an in-memory double that
 * auto-expires is testing its own timer, not the counter.
 */
class FakeCounter {
  readonly calls: string[] = []
  readonly sets: { key: string; value: string; EX?: number; NX?: boolean }[] = []
  counts = new Map<string, number>()

  async set(key: string, value: string, options: { NX: true; EX: number }): Promise<string> {
    this.calls.push('set')
    this.sets.push({ key, value, ...options })

    if (!this.counts.has(key)) this.counts.set(key, Number(value))
    return 'OK'
  }

  async incr(key: string): Promise<number> {
    this.calls.push('incr')
    const next = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, next)
    return next
  }

  asRedis(): CounterRedis {
    // The double stands in for a `RedisClientType`; casting is how this repo
    // substitutes for a real client (see conventions.md §4 on `as never`).
    return this as unknown as CounterRedis
  }
}

const WINDOW = 60
const spec = (limit: number) => ({ limit, windowSeconds: WINDOW })

describe('window arithmetic', () => {
  it('names a window by its index from the epoch, so instances agree without talking', () => {
    const t = 1_700_000_000_000

    expect(bucketWindow(WINDOW, t).index).toBe(Math.floor(t / 60_000))
    // Same minute, same name — one admin behind two instances is one bucket.
    expect(windowKey('write', 'user-1', WINDOW, t)).toBe(windowKey('write', 'user-1', WINDOW, t + 30_000))
    // Next minute, different name. Nothing ever resets a counter, because nothing
    // has to: the reset is implicit in the key changing.
    expect(windowKey('write', 'user-1', WINDOW, t)).not.toBe(windowKey('write', 'user-1', WINDOW, t + 60_000))
  })

  it('keeps the prefix singular and the parts separated, so one SCAN finds every key', () => {
    expect(windowKey('anon', '203.0.113.7', WINDOW, 1_700_000_000_000)).toMatch(
      new RegExp(`^${RATE_LIMIT_PREFIX}:anon:203\\.0\\.113\\.7:\\d+$`),
    )
  })

  /**
   * The ceiling on `Retry-After` is the window itself. A client told to wait longer
   * than the period the limit is expressed in is being lied to — the bucket it is
   * waiting for rolls over sooner than that.
   */
  it('reports a retry-after that is a positive whole number no longer than the window', () => {
    // Anchored to a window start so `offset` means what it says: seconds into the
    // window, whichever minute that happens to be.
    const start = 1_700_000_000_000 - (1_700_000_000_000 % 60_000)

    for (const offsetMs of [0, 1, 500, 1_000, 45_000, 59_999]) {
      const { retryAfterSeconds } = bucketWindow(WINDOW, start + offsetMs)

      expect(Number.isInteger(retryAfterSeconds)).toBe(true)
      expect(retryAfterSeconds).toBeGreaterThanOrEqual(1)
      expect(retryAfterSeconds).toBeLessThanOrEqual(WINDOW)
    }
  })

  it('counts down as the window runs out rather than always saying the full minute', () => {
    const start = 1_700_000_000_000 - (1_700_000_000_000 % 60_000)

    expect(bucketWindow(WINDOW, start).retryAfterSeconds).toBe(60)
    expect(bucketWindow(WINDOW, start + 45_000).retryAfterSeconds).toBe(15)
    // One millisecond before rollover still says "1", never "0" — a zero would
    // invite an immediate retry, which is the thing being prevented.
    expect(bucketWindow(WINDOW, start + 59_999).retryAfterSeconds).toBe(1)
  })
})

describe('consumeWindow boundary', () => {
  /**
   * Both sides of the line. Testing only the rejection is how an off-by-one lives
   * forever: a limiter that stops at 59 and one that stops at 61 both "return 429
   * eventually".
   */
  it('allows the limit-th request and refuses the limit+1-th', async () => {
    const fake = new FakeCounter()
    const key = windowKey('write', 'u', WINDOW)

    for (let i = 1; i <= 60; i += 1) {
      const decision = await consumeWindow(fake.asRedis(), key, spec(60))
      expect(decision.allowed, `request ${i}`).toBe(true)
      expect(decision.count).toBe(i)
    }

    const rejected = await consumeWindow(fake.asRedis(), key, spec(60))
    expect(rejected.allowed).toBe(false)
    expect(rejected.count).toBe(61)
    expect(rejected.retryAfterSeconds).toBeGreaterThanOrEqual(1)
    expect(rejected.retryAfterSeconds).toBeLessThanOrEqual(WINDOW)
  })

  it('gives no retry-after on an allowed request, so a caller cannot leak one', async () => {
    const fake = new FakeCounter()
    const decision = await consumeWindow(fake.asRedis(), windowKey('write', 'u', WINDOW), spec(60))

    expect(decision.allowed).toBe(true)
    expect(decision.retryAfterSeconds).toBeUndefined()
  })

  it('separates buckets: filling one identity does not touch another', async () => {
    const fake = new FakeCounter()
    const a = windowKey('write', 'a', WINDOW)
    const b = windowKey('write', 'b', WINDOW)

    for (let i = 0; i < 61; i += 1) await consumeWindow(fake.asRedis(), a, spec(60))

    expect((await consumeWindow(fake.asRedis(), b, spec(60))).allowed).toBe(true)
  })

  /**
   * S6-R1, stated as a contract on the call sequence.
   *
   * The order is asserted here so that a reader who refactors `consumeWindow` is
   * stopped by a test, but this double cannot demonstrate *why* the order matters:
   * nothing kills the process between the two calls. That is what the real-Redis
   * `TTL > 0` assertion in `test/rate-limit.test.ts` is for, and swapping the two
   * commands is what makes that one go red.
   */
  it('sets with EX before it increments, never increments then expires', async () => {
    const fake = new FakeCounter()
    await consumeWindow(fake.asRedis(), windowKey('write', 'u', WINDOW), spec(60))

    expect(fake.calls).toEqual(['set', 'incr'])
    expect(fake.sets).toHaveLength(1)
    expect(fake.sets[0]!.EX).toBe(WINDOW)
    expect(fake.sets[0]!.NX).toBe(true)
    // '0' and not '1': the INCR that follows is what makes the first request count
    // as one. Setting '1' here and incrementing would double-count.
    expect(fake.sets[0]!.value).toBe('0')
  })
})

describe('fail-open (S6-R6)', () => {
  /**
   * A Redis that answers nothing is the outage this is designed for. The decision
   * must be "allow": rate limiting is a shield around the blog, not an access
   * control, so failing closed turns one flapping container into "every visitor
   * gets 429" — a worse outage than the flooding the limit exists to prevent.
   */
  it('allows the request and reports failedOpen instead of throwing', async () => {
    const down: CounterRedis = {
      set: async () => {
        throw new Error('Connection is closed')
      },
      incr: async () => {
        throw new Error('Connection is closed')
      },
    }

    const decision = await consumeWindow(down, windowKey('write', 'u', WINDOW), spec(60))

    expect(decision.allowed).toBe(true)
    expect(decision.failedOpen).toBe(true)
    // Nothing was counted, so no number may be claimed — reporting `0` as a count
    // would imply a decision that was never made.
    expect(decision.count).toBe(0)
    expect((decision.error as Error).message).toBe('Connection is closed')
  })

  it('fails open when only the INCR half breaks', async () => {
    // The realistic partial outage: `disableOfflineQueue` lets the first command
    // land and the second reject mid-flight. Both halves are inside one try, and
    // a half-protected one would throw a 500 at a caller who did nothing wrong.
    const half: CounterRedis = {
      set: async () => 'OK',
      incr: async () => {
        throw new Error('READONLY You cannot write against a read only replica')
      },
    }

    const decision = await consumeWindow(half, windowKey('write', 'u', WINDOW), spec(60))
    expect(decision.allowed).toBe(true)
    expect(decision.failedOpen).toBe(true)
  })
})
