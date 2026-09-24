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
    // Both dependencies are always checked, rather than short-circuiting on the
    // first failure. When something is wrong, the first thing you want to know
    // is *which* dependency is down — short-circuiting hides that.
    const [postgres, redis] = await Promise.allSettled([
      withTimeout(app.db.query('select 1'), DEPENDENCY_TIMEOUT_MS, 'postgres'),
      withTimeout(app.redis.ping(), DEPENDENCY_TIMEOUT_MS, 'redis'),
    ])

    const checks: Record<string, 'ok' | 'failed'> = {
      postgres: postgres.status === 'fulfilled' ? 'ok' : 'failed',
      redis: redis.status === 'fulfilled' ? 'ok' : 'failed',
    }

    const allOk = Object.values(checks).every((value) => value === 'ok')

    if (!allOk) {
      request.log.warn({ checks }, 'readiness check failed')
    }

    // 503 is what tells a load balancer to stop routing here. Returning 200 with
    // a failed body would keep traffic flowing to an instance that cannot serve.
    return reply.code(allOk ? 200 : 503).send({
      status: allOk ? 'ok' : 'degraded',
      checks,
    })
  })
}
