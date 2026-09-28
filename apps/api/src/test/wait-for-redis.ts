import type { FastifyInstance } from 'fastify'

/**
 * Waits until the Redis client has actually connected.
 *
 * Needed because redisPlugin deliberately does not await the first connect — a
 * Redis outage must not block startup (see plugins/redis.ts), so `buildApp()`
 * returns while the client is still dialling and `disableOfflineQueue` makes any
 * command in that window fail immediately rather than queue.
 *
 * That is correct production behaviour: the load balancer holds traffic until
 * /ready says so. Tests that call buildApp() and issue a command on the next line
 * are the ones place that skips the readiness step, so they wait for it here.
 *
 * Shared because the same race showed up in three files, and a per-file copy is
 * how one of them ends up fixed and the others left flaky.
 */
export async function waitForRedis(app: FastifyInstance, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (!app.redis.isReady) {
    if (Date.now() > deadline) {
      throw new Error(`redis did not become ready within ${timeoutMs}ms — is REDIS_URL reachable?`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
