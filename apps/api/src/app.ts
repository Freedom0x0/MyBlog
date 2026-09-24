import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Config } from './config/index.js'
import { dbPlugin } from './plugins/db.js'
import { redisPlugin } from './plugins/redis.js'
import { errorHandlerPlugin } from './plugins/errorHandler.js'
import { healthRoutes } from './routes/health.js'

export interface BuildAppOptions {
  config: Config
}

/**
 * Assemble the Fastify instance.
 *
 * Deliberately does NOT call `listen()`. Keeping assembly and listening apart is
 * what makes the API testable: tests import this and drive it with
 * `app.inject()`, which sends a request through the full routing stack without
 * binding a port. `server.ts` owns the listening concern.
 */
export async function buildApp({ config }: BuildAppOptions): Promise<FastifyInstance> {
  const isDev = config.NODE_ENV === 'development'

  const app = Fastify({
    // Fastify's logger *is* pino — it is built in, so there is no separate pino
    // dependency to install or wire up. Production emits JSON; development gets
    // pino-pretty so logs are readable while working.
    logger: isDev
      ? {
          level: config.LOG_LEVEL,
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : { level: config.LOG_LEVEL },

    // Both are native Fastify options, so no custom request-id plugin is
    // needed. If the caller already sent an id we keep it, which is what lets a
    // single id follow a request across services; otherwise we mint one.
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  })

  // Infrastructure first, so anything registered later can rely on app.db and
  // app.redis existing.
  await app.register(dbPlugin, { config })
  await app.register(redisPlugin, { config })

  // Registered after the plugins so it also covers errors they throw.
  await app.register(errorHandlerPlugin)
  await app.register(healthRoutes)

  return app
}
