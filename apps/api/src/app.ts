import { randomUUID } from 'node:crypto'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import type { Config } from './config/index.js'
import { dbPlugin } from './plugins/db.js'
import { redisPlugin } from './plugins/redis.js'
import { denylistPlugin } from './plugins/denylist.js'
import { configPlugin } from './plugins/config.js'
import { authPlugin } from './plugins/auth.js'
import { authRoutes } from './modules/auth/routes.js'
import { errorHandlerPlugin } from './plugins/errorHandler.js'
import { healthRoutes } from './routes/health.js'
import { mediaPlugin } from './plugins/media.js'
import { articleRoutes } from './modules/articles/routes.js'
import { commentRoutes } from './modules/comments/routes.js'
import { tagRoutes } from './modules/tags/routes.js'
import { uploadRoutes } from './modules/uploads/routes.js'

export interface BuildAppOptions {
  config: Config
  /**
   * Overrides the log destination. Tests use it to assert that credentials never
   * reach the log, which is the one leak a running service cannot be inspected
   * for afterwards — by then it is already in the aggregation system.
   */
  loggerDestination?: NodeJS.WritableStream
}

/**
 * Assemble the Fastify instance.
 *
 * Deliberately does NOT call `listen()`. Keeping assembly and listening apart is
 * what makes the API testable: tests import this and drive it with
 * `app.inject()`, which sends a request through the full routing stack without
 * binding a port. `server.ts` owns the listening concern.
 */
export async function buildApp({
  config,
  loggerDestination,
}: BuildAppOptions): Promise<FastifyInstance> {
  const isDev = config.NODE_ENV === 'development'

  const app = Fastify({
    // Fastify's logger *is* pino — it is built in, so there is no separate pino
    // dependency to install or wire up. Production emits JSON; development gets
    // pino-pretty so logs are readable while working.
    logger:
      loggerDestination !== undefined
        ? { level: config.LOG_LEVEL, stream: loggerDestination as unknown as NodeJS.WritableStream }
        : isDev
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

  // Zod is the single definition source for both validation and types, so a
  // route's DTO is not hand-mirrored into a second type declaration.
  // First: everything downstream reads app.config / app.oauthProvider.
  await app.register(configPlugin, { config })

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  /**
   * A single allowlisted origin, and no credentials.
   *
   * S1's endpoints are public reads, so cookies must not be sent or honoured —
   * `credentials: true` alongside a wildcard is the combination that turns a
   * permissive CORS setting into a real problem. S2 moves authorisation into
   * cookies, at which point this needs revisiting deliberately: allow the portal
   * origin AND credentials, never `*` with both.
   */
  await app.register(cors, {
    origin: config.PORTAL_WEB_ORIGIN,
    /**
     * `@fastify/cors` defaults to `GET,HEAD,POST` (its `index.js:11`, and the
     * preflight answers with that static list verbatim). S3's write surface is
     * `PATCH` and `DELETE`, so the default silently refuses the admin UI's own
     * publish and delete buttons at preflight — silently, because `app.inject()`
     * runs the request lifecycle but no browser same-origin check, so every
     * existing test passed while the real browser could not make the call. The
     * guard lives in `test/cors.test.ts`, which asserts on the preflight response
     * itself; nothing else in this suite can see this setting.
     *
     * Only the verbs the API actually routes. `PUT` is absent on purpose: this
     * surface uses PATCH, and an allow list that includes what we do not serve is
     * a wider door for no reason.
     */
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'],
    /**
     * True from S2 onward because the session now travels in a cookie, and a
     * cross-origin fetch will not attach one unless the response says it may.
     *
     * Paired with a single explicit origin on purpose: `credentials: true` with a
     * wildcard is rejected by browsers, and if it were accepted it would let any
     * site ride along a visitor's session. Both halves are load-bearing — the
     * strictest-looking setting here is the combination, not either knob alone.
     */
    credentials: true,
  })

  // Infrastructure first, so anything registered later can rely on app.db and
  // app.redis existing.
  await app.register(dbPlugin, { config })
  await app.register(redisPlugin, { config })
  // After redisPlugin: the denylist is stored in Redis.
  await app.register(denylistPlugin)

  /**
   * After the other infrastructure plugins and before the routes, like `db`: the
   * upload routes read `app.media`. The bucket assurance runs here, at assembly, and
   * never fails assembly — see `plugins/media.ts` for why an unreachable MinIO must
   * not take the process (or the public reads) down with it.
   */
  await app.register(mediaPlugin, { config })

  // Before authPlugin: requireAuth reads the access token from a cookie, and
  // request.cookies only exists once @fastify/cookie has run.
  await app.register(cookie)
  await app.register(authPlugin, { config })

  // Registered after the plugins so it also covers errors they throw.
  await app.register(errorHandlerPlugin)
  await app.register(healthRoutes)
  await app.register(articleRoutes)
  await app.register(commentRoutes)
  await app.register(tagRoutes)
  await app.register(uploadRoutes)
  await app.register(authRoutes)

  return app
}
