import { ConfigError, loadConfig } from './config/index.js'
import { buildApp } from './app.js'

/**
 * Entry point: the only place that owns process-level concerns — reading the
 * environment, binding a port, and reacting to signals.
 */
async function main(): Promise<void> {
  // Config problems are startup failures, never request-time failures.
  let config
  try {
    config = loadConfig()
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message)
      process.exit(1)
    }
    throw error
  }

  const app = await buildApp({ config })

  /**
   * Graceful shutdown.
   *
   * An orchestrator sends SIGTERM, then waits, then SIGKILLs. Without a handler,
   * the process dies instantly and every in-flight request is dropped — users
   * see errors on every deploy. `app.close()` stops accepting new connections
   * and waits for in-flight ones to finish.
   *
   * In a rolling deploy this is only half the story: the load balancer also has
   * to stop routing to this instance. That is what readiness is for — flip
   * /ready to 503 first, wait for connections to drain, then close. The full
   * sequence belongs to S7/S8; this handler gives the process-level half.
   */
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down')
      app.close().then(
        () => process.exit(0),
        (error: unknown) => {
          app.log.error({ err: error }, 'shutdown failed')
          process.exit(1)
        },
      )
    })
  }

  try {
    // Bound to loopback on purpose: this is a local dev process during S0 and
    // has no business being reachable from the LAN. It becomes 0.0.0.0 when the
    // API is containerised in S8.
    await app.listen({ port: config.PORT, host: '127.0.0.1' })
  } catch (error) {
    app.log.error({ err: error }, 'failed to start')
    process.exit(1)
  }
}

/**
 * Startup failures are handled here, at the process boundary. Without this, an
 * unexpected rejection — a plugin that fails to start, for example — surfaces as
 * a raw internal stack trace and an unclear exit status.
 */
main().catch((error: unknown) => {
  console.error('Fatal error during startup:')
  console.error(error)
  process.exit(1)
})
