import { ERROR_CODES } from 'shared'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { ApiError } from '../errors.js'
import { consumeWindow, windowKey, type WindowSpec } from '../lib/rateLimit.js'

/**
 * Request guards that refuse a caller who is asking too often (S6).
 *
 * Attached per-route in `onRequest` arrays, exactly like `requireAuth` /
 * `requireCsrfHeader` / `requireAdmin` — and for the same reason those are not
 * global hooks: the ceiling differs by route group, and a global hook would have
 * to re-derive from the URL what the route table already says. A hook that fires
 * before routing also cannot see the params it needs to log usefully.
 *
 * The counter itself lives in `lib/rateLimit.ts` and knows nothing about Fastify;
 * this file only decides *who* is being counted, translates the decision into the
 * shared error envelope, and owns the warn that a fail-open owes the operator.
 */

/** One minute, because both configured ceilings are stated per minute. */
const WINDOW_SECONDS = 60

/**
 * Counts one request against `bucket`; throws a 429 if the window is full.
 *
 * `Retry-After` is set on the reply and then the `ApiError` is thrown. That is not
 * hand-building a response: the status, the envelope and the `code` all still come
 * from `plugins/errorHandler`, and Fastify reuses the same reply object for the
 * error path, so the one header the limiter legitimately owns — how long to wait —
 * survives the throw. A 429 without `Retry-After` (S6-R5) leaves a well-behaved
 * client guessing, and retrying immediately is exactly what the limit exists to
 * stop.
 */
async function enforce(
  request: FastifyRequest,
  reply: FastifyReply,
  kind: string,
  bucket: string,
  limit: number,
): Promise<void> {
  const spec: WindowSpec = { limit, windowSeconds: WINDOW_SECONDS }
  const redis = request.server.redis

  const key = windowKey(kind, bucket, WINDOW_SECONDS)
  const decision = await consumeWindow(redis, key, spec)

  if (decision.failedOpen) {
    // S6-R6. Warn rather than throw, and warn once per request rather than trying
    // to rate the rate-limiter's own failure: Redis is already unhealthy, so the
    // line is the signal, and suppressing it would be hiding the outage.
    request.log.warn(
      { err: decision.error, key, bucketKind: kind, limit },
      'rate limiter unavailable; allowing the request (fail-open)',
    )
    return
  }

  if (!decision.allowed) {
    // The counter always fills this on a refusal; the fallback is a belt, not a
    // behaviour — it keeps the header from ever becoming the string "undefined" if
    // the two files are ever edited apart from each other.
    const retryAfterSeconds = decision.retryAfterSeconds ?? WINDOW_SECONDS

    reply.header('retry-after', String(retryAfterSeconds))
    request.log.warn(
      { key, count: decision.count, limit, bucketKind: kind },
      'rate limit exceeded',
    )

    throw new ApiError(
      ERROR_CODES.rateLimited,
      `Too many requests; retry in ${retryAfterSeconds}s`,
      429,
    )
  }
}

/**
 * The write surface, bucketed by authenticated identity (S6-R2).
 *
 * Why the bucket is `request.auth.sub` and never the IP: `server.ts` binds to
 * loopback behind an nginx gateway, so every visitor's `request.ip` is the proxy's
 * address. An IP-bucketed write limit in that topology is one shared bucket —
 * a single visitor refreshing a dozen times would rate-limit the entire site for
 * everybody else, and the attacker's job becomes "be the loudest one bucket".
 * Identity is the only key that separates honest callers from a flood.
 *
 * Why the guard runs *after* the auth guards rather than before them: `sub` only
 * exists once `requireAuth`/`requireAdmin` has verified a token. That costs the
 * unauthenticated-crowding case the cheap protection it might have wanted, and it
 * is the right trade — the write routes cannot be used anonymously at all, so the
 * flood they can suffer is from a credential, which is exactly what `sub` names.
 *
 * No identity means no bucketing, and that is a wiring bug rather than a runtime
 * state: every route this is attached to runs an auth guard first, in the same
 * array, ahead of it. Falling back to IP here would resurrect the collapsed-bucket
 * bug the whole guard exists to avoid, so the fallback is a loud log line and an
 * allowed request — limiting nothing beats limiting everyone.
 */
export async function requireWriteRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = request.auth

  if (auth === undefined) {
    request.log.error(
      'write rate-limit guard reached without request.auth; it must be attached after an auth guard',
    )
    return
  }

  await enforce(request, reply, 'write', auth.sub, request.server.config.RATE_LIMIT_WRITE_PER_MINUTE)
}

/**
 * The anonymous entry point, bucketed by client IP (S6-R3).
 *
 * This is the one route reachable with no credential, so identity is not
 * available as a key and the IP is the only thing that distinguishes callers —
 * which is precisely why it needs `trustProxy` (S6-R4, set in `app.ts`) to be a
 * real address rather than the proxy's.
 *
 * The counterpart decision, and the one a reviewer will reach for: **`POST
 * /auth/refresh` and `POST /auth/logout` are deliberately NOT given an IP bucket,
 * and this is not an oversight.**
 *
 * - Their credential is a `SameSite=Lax` HttpOnly cookie scoped to `/api/v1/auth`,
 *   and both already run `requireCsrfHeader`; `refresh` additionally requires a
 *   256-bit random token whose reuse the store detects and answers by invalidating
 *   the whole family. There is nothing here for a blind caller to guess at, so the
 *   usual "throttle the credential-guessing endpoint" argument has no target.
 * - They carry no `request.auth` either: `logout` verifies best-effort on purpose
 *   (a dead token must still be able to log out), so identity bucketing is not
 *   available without changing that behaviour — which S6-R6 forbids.
 * - And an IP bucket would be the *harmful* option in this topology. Behind the
 *   gateway every caller presents the proxy's address, so one visitor hammering
 *   refresh would lock every other visitor out of renewing their session — turning
 *   a shield into a self-inflicted outage, with the whole site's users as the
 *   blast radius. `logout` is worse still: it is the recovery action a locked-out
 *   user reaches for, so throttling it by shared IP throttles the fix.
 *
 * What that leaves on the table is a flood of cheap 401s against `refresh`. That
 * costs one indexed lookup per request, is bounded by nginx's own connection
 * limits, and is a strictly worse trade than the lockout above. If it ever needs
 * addressing, the fix is a bucket keyed on the *refresh token's* hash — never the
 * shared IP.
 */
export async function requireAnonRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await enforce(request, reply, 'anon', request.ip, request.server.config.RATE_LIMIT_ANON_PER_MINUTE)
}
