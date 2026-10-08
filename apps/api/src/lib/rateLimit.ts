/**
 * Fixed-window request counter (S6).
 *
 * Deliberately free of Fastify: it takes a Redis-shaped dependency rather than an
 * app, so the fail-open path is testable with a double whose calls reject — which
 * is the only way to exercise a Redis outage without shutting a live container.
 *
 * Why a fixed window and not a sliding one or a token bucket: a fixed window needs
 * two commands and one round trip's worth of state, and the thing being protected
 * is a blog, not a payment gateway. The known imprecision — up to 2x the limit
 * across a window boundary — buys the simplicity, and nothing here consumes a
 * burst-smoothed number. Recorded so the next reader does not "fix" it into a
 * Lua script for no requester.
 */

/** The two commands the counter needs, as node-redis exposes them. */
export interface CounterRedis {
  set(key: string, value: string, options: { NX: true; EX: number }): Promise<unknown>
  incr(key: string): Promise<number>
}

export interface WindowSpec {
  /** Requests allowed per window. */
  limit: number
  /** Window length in seconds; also the ceiling on `Retry-After`. */
  windowSeconds: number
}

export interface RateLimitDecision {
  allowed: boolean
  /** The bucket key consulted — in the warn line and in tests. */
  key: string
  /**
   * Requests counted in this window including this one.
   *
   * `0` when `failedOpen`: nothing was counted, so reporting a number would
   * imply a decision that was never made.
   */
  count: number
  /**
   * Whole seconds until this window rolls over.
   *
   * Present exactly when `allowed` is false, so a caller cannot forget it and
   * answer 429 with no way for the client to know when to come back.
   */
  retryAfterSeconds?: number
  /** Redis refused to answer; the caller must allow the request and warn (S6-R6). */
  failedOpen: boolean
  /** What Redis said, kept for the log line — never returned to a client. */
  error?: unknown
}

/**
 * Namespace for every key this module writes.
 *
 * One prefix, so "which keys are ours" is answerable with a single SCAN — that is
 * what lets the tests clean up after themselves and the residue check mean
 * something.
 */
export const RATE_LIMIT_PREFIX = 'rl'

/**
 * Which window `now` falls in, and how long is left in it.
 *
 * The window index is derived from the epoch clock rather than from the key's
 * creation time, and that is what makes the index stateless to compute: two
 * instances in the same second agree on the name without ever talking to each
 * other. The cost is boundary alignment to epoch minutes, which nobody observes.
 *
 * `Retry-After` comes from the same arithmetic as the key rather than from a
 * `PTTL` read, because reading the TTL would cost a third round trip on the path
 * this module exists to make cheap, for a number the clock already knows. It is
 * clamped to `[1, windowSeconds]` so a client can never be told to wait longer than
 * the limit's own period, and can never be told `0` — which reads as "retry now",
 * the exact behaviour the response is meant to change.
 */
export function bucketWindow(
  windowSeconds: number,
  now: number = Date.now(),
): { index: number; retryAfterSeconds: number } {
  const windowMs = windowSeconds * 1_000
  const index = Math.floor(now / windowMs)
  const remainingMs = (index + 1) * windowMs - now

  return { index, retryAfterSeconds: clampRetryAfter(remainingMs, windowSeconds) }
}

function clampRetryAfter(remainingMs: number, windowSeconds: number): number {
  return Math.min(windowSeconds, Math.max(1, Math.ceil(remainingMs / 1_000)))
}

/**
 * The full key for a bucket: prefix, kind, bucket, window index.
 *
 * The window index is *in the name*, which is why this is a fixed window and why
 * no code path ever has to reset a counter: the next window simply counts into a
 * different key.
 */
export function windowKey(kind: string, bucket: string, windowSeconds: number, now: number = Date.now()): string {
  return `${RATE_LIMIT_PREFIX}:${kind}:${bucket}:${bucketWindow(windowSeconds, now).index}`
}

/**
 * Count one request against a window and decide whether it is over the limit.
 *
 * **The two Redis calls are in this order for one reason and the reason is not
 * style (S6-R1).** First `SET key '0' NX EX <window>` — which creates the bucket
 * *with its expiry already attached* — and only then `INCR`.
 *
 * The intuitive order (create/increment, then `EXPIRE`) has a two-command gap. If
 * the process dies, the connection drops, or the `EXPIRE` is rejected in that gap,
 * the key survives with no TTL — and because the window index is baked into the
 * name, that key is the bucket for a window that has already passed, so it is
 * never read again and never expires: an immortal `rl:*` row in Redis for a
 * window nobody consults. `SET NX EX` cannot produce that state; the expiry is
 * part of the creation, not a second step that might not happen.
 *
 * The `NX` is what makes the pair safe to repeat: once the key exists, the `SET`
 * is a no-op and cannot reset the TTL, so a window that keeps receiving traffic
 * still closes on schedule instead of sliding forever.
 *
 * Never throws. A Redis failure returns `failedOpen: true` with `allowed: true`,
 * and the caller logs it: rate limiting is a shield around the blog, not an
 * access control, so fail-closed would turn a Redis wobble into "everyone gets
 * 429" — a worse outage than the flooding it was meant to prevent.
 */
export async function consumeWindow(
  redis: CounterRedis,
  key: string,
  spec: WindowSpec,
  now: number = Date.now(),
): Promise<RateLimitDecision> {
  const { retryAfterSeconds } = bucketWindow(spec.windowSeconds, now)

  try {
    await redis.set(key, '0', { NX: true, EX: spec.windowSeconds })
    const count = await redis.incr(key)

    if (count > spec.limit) {
      return { allowed: false, key, count, retryAfterSeconds, failedOpen: false }
    }

    return { allowed: true, key, count, failedOpen: false }
  } catch (error) {
    return { allowed: true, key, count: 0, failedOpen: true, error }
  }
}
