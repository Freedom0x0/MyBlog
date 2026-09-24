import { z } from 'zod'

/**
 * Environment schema.
 *
 * Validated once at boot, not read lazily at request time. See `loadConfig`
 * for why that distinction matters.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),

  // Required with no default on purpose: a missing connection string must stop
  // the process at boot rather than surface as a 500 on some later request.
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
})

export type Config = z.infer<typeof EnvSchema>

/** Thrown when the environment is unusable. Caught by the entry point. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * Parse and validate the environment.
 *
 * Two deliberate choices:
 *
 * 1. Throws instead of calling `process.exit`. Exiting from deep inside a
 *    library function makes it untestable and hides the control flow; the
 *    entry point decides what a bad config means.
 *
 * 2. Reports *every* problem at once, not just the first. Fixing missing config
 *    one variable per restart is a miserable loop.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(env)

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const name = issue.path.join('.') || '(root)'
        return `  - ${name}: ${issue.message}`
      })
      .join('\n')

    throw new ConfigError(`Invalid environment configuration:\n${details}`)
  }

  return result.data
}
