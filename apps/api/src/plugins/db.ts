import fp from 'fastify-plugin'
import { Pool } from 'pg'
import type { FastifyInstance } from 'fastify'
import type { Config } from '../config/index.js'

declare module 'fastify' {
  interface FastifyInstance {
    db: Pool
  }
}

/**
 * Postgres connection pool, decorated onto the instance as `app.db`.
 *
 * Wrapped in `fastify-plugin` to break encapsulation. Fastify plugins are
 * scoped by default: a decorator added inside a normal plugin is visible only to
 * that plugin's children, so routes registered elsewhere would see `app.db` as
 * undefined. `fp()` opts out of that scoping, which is what infrastructure
 * plugins almost always want.
 *
 * The `declare module` block above is what makes `app.db` type-check. Fastify's
 * decorators are invisible to TypeScript without it.
 */
export const dbPlugin = fp(
  async (app: FastifyInstance, options: { config: Config }): Promise<void> => {
    const pool = new Pool({
      connectionString: options.config.DATABASE_URL,
      max: 10,
    })

    /**
     * Idle clients can fail on their own (server restart, network blip). Pool
     * emits `error` for those, and an unhandled `error` event on an EventEmitter
     * terminates the process. This handler is not optional.
     */
    pool.on('error', (error) => {
      app.log.error({ err: error }, 'idle postgres client error')
    })

    app.decorate('db', pool)

    // Release the pool when the instance closes, so graceful shutdown actually
    // drains connections instead of leaving them for Postgres to time out.
    app.addHook('onClose', async () => {
      await pool.end()
    })
  },
)
