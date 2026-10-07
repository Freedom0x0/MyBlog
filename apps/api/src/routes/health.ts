import type { FastifyInstance } from 'fastify'
import type { LivenessPayload, ReadinessPayload } from 'shared'

/**
 * A readiness probe that hangs is as useless as one that fails: the caller waits
 * forever instead of being told the answer. Every dependency check is therefore
 * bounded.
 */
const DEPENDENCY_TIMEOUT_MS = 2_000

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })

  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Liveness and readiness answer different questions and must not share an
 * implementation:
 *
 *   /health  "is the process alive?"   — checks nothing, never returns 503
 *   /ready   "can it serve traffic?"   — checks every dependency
 *
 * Collapsing them is a classic production outage. If the liveness probe checked
 * the database, a brief database blip would make the orchestrator conclude the
 * process is dead and restart it. Restarting does not fix the database, so the
 * original problem is now joined by a restart loop.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (): Promise<LivenessPayload> => ({ status: 'ok' }))

  app.get('/ready', async (request, reply): Promise<ReadinessPayload> => {
    // All three dependencies are always checked, rather than short-circuiting on the
    // first failure. When something is wrong, the first thing you want to know
    // is *which* dependency is down — short-circuiting hides that.
    const [postgres, redis, media] = await Promise.allSettled([
      withTimeout(app.db.query('select 1'), DEPENDENCY_TIMEOUT_MS, 'postgres'),
      withTimeout(app.redis.ping(), DEPENDENCY_TIMEOUT_MS, 'redis'),
      withTimeout(app.mediaReady(), DEPENDENCY_TIMEOUT_MS, 'media'),
    ])

    const checks: Record<string, 'ok' | 'failed'> = {
      postgres: postgres.status === 'fulfilled' ? 'ok' : 'failed',
      redis: redis.status === 'fulfilled' ? 'ok' : 'failed',
      media: media.status === 'fulfilled' ? 'ok' : 'failed',
    }

    /**
     * Two different questions, so two different values — and this split is the whole
     * point of the `trafficOk` name.
     *
     * `trafficOk` (postgres + redis only) decides the **status code**, because those
     * two are what makes an article read fail. Pulling an instance out of rotation
     * for a MinIO outage would take the blog down over a feature that is only
     * uploads.
     *
     * `status` additionally reflects media, so an operator or a monitoring query
     * sees `degraded` while the site still serves 200s. That is the shape the type
     * already implies: `degraded` is not `not ready`, and conflating them is how a
     * media bucket ends up restarting a healthy process.
     */
    const trafficOk = checks.postgres === 'ok' && checks.redis === 'ok'
    const allOk = trafficOk && checks.media === 'ok'

    if (!allOk) {
      request.log.warn({ checks, trafficOk }, 'readiness check degraded or failed')
    }

    // 503 is what tells a load balancer to stop routing here — see `trafficOk` above
    // for why media failure does NOT earn one. Returning 200 with a failed body would
    // keep traffic flowing to an instance that cannot serve.
    // `satisfies` here is not decoration. `reply.send()`'s payload parameter is
    // untyped in Fastify, so the `Promise<ReadinessPayload>` annotation on this
    // arrow never reaches the object literal below — measured, not assumed: adding a
    // required field to `ReadinessPayload` in `shared` leaves `tsc` completely clean
    // without this line, while the same mutation against the `/health` literal above
    // and against `ApiErrorEnvelope` in the error handler both fail to compile. This
    // endpoint is the contract a load balancer reads, so drift here is exactly the
    // kind that should stop a build rather than surface as a probe that silently
    // never trips.
    return reply.code(trafficOk ? 200 : 503).send({
      status: allOk ? 'ok' : 'degraded',
      checks,
    } satisfies ReadinessPayload)
  })
}
