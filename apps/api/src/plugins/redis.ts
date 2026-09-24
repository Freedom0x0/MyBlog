import fp from 'fastify-plugin'
import { createClient, type RedisClientType } from 'redis'
import type { FastifyInstance } from 'fastify'
import type { Config } from '../config/index.js'

declare module 'fastify' {
  interface FastifyInstance {
    redis: RedisClientType
  }
}

/**
 * Redis client, decorated onto the instance as `app.redis`.
 *
 * Why Redis is not optional in this architecture: the API is meant to run as
 * several instances behind a load balancer (S7). Anything kept in process memory
 * — a cache, a rate-limit counter, a token denylist — exists once per instance
 * and therefore gives inconsistent answers depending on which instance the load
 * balancer picked. Shared mutable state belongs here, and nowhere else.
 */
export const redisPlugin = fp(
  async (app: FastifyInstance, options: { config: Config }): Promise<void> => {
    const client = createClient({
      url: options.config.REDIS_URL,
      socket: {
        // Bounds each individual TCP attempt, so a black-holed host cannot leave
        // a connection hanging indefinitely.
        connectTimeout: 2_000,
        // Keep retrying forever, backing off to 3s. A Redis restart should heal
        // on its own without anyone restarting the API.
        reconnectStrategy: (retries) => Math.min(retries * 100, 3_000),
      },
      // Without this, commands issued while disconnected are queued and only
      // settle once a connection exists — so /ready would hang until its own
      // timeout instead of reporting the outage immediately.
      disableOfflineQueue: true,
    })

    // node-redis emits `error` on connection trouble. Without a listener the
    // event is unhandled and takes the process down.
    client.on('error', (error) => {
      app.log.error({ err: error }, 'redis client error')
    })

    /**
     * Deliberately NOT awaited.
     *
     * An unreachable dependency is a readiness concern, not a startup concern
     * (see routes/health.ts): the process should come up, report `/ready` 503,
     * and recover once Redis returns. Awaiting the first connection made a Redis
     * outage prevent startup entirely — asymmetric with Postgres, whose Pool
     * connects lazily — and turned an outage into a crash loop.
     *
     * `reconnectStrategy` keeps retrying, so this promise usually stays pending
     * rather than rejecting; the catch is for the case where it does reject.
     */
    client.connect().catch((error: unknown) => {
      app.log.error({ err: error }, 'initial redis connection failed; retrying in background')
    })

    app.decorate('redis', client)

    app.addHook('onClose', async () => {
      // destroy() rather than quit(): quit() sends a command over the wire and
      // would reject if the initial connection never succeeded.
      client.destroy()
    })
  },
)
