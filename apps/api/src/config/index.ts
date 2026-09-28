import { z } from 'zod'

/**
 * Environment schema.
 *
 * Validated once at boot, not read lazily at request time. See `loadConfig`
 * for why that distinction matters.
 *
 * Nothing here may carry a `VITE_`/`NEXT_PUBLIC_` prefix by another name: those
 * are inlined into the browser bundle, and several of these values are secrets.
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

  /**
   * Signing key for access tokens.
   *
   * 32 characters of base64url is ~192 bits of entropy, comfortably past HS256's
   * 256-bit key expectation for practical purposes. The minimum is enforced at
   * boot rather than trusted to convention because a hand-typed "long enough"
   * secret is the normal failure mode, and the cost of starting anyway is that
   * every token ever issued becomes brute-forceable.
   */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters; generate one with crypto.randomBytes(32)'),

  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(180).default(30),

  /**
   * OAuth provider base URL.
   *
   * Configurable so tests can point at a local stub and exercise the same code
   * path as production — including the failure branches a real provider will not
   * produce on demand (a spent code replayed, an `error=` callback, a 401
   * exchange).
   */
  OAUTH_BASE_URL: z.string().url().default('https://github.com'),
  OAUTH_CLIENT_ID: z.string().min(1),
  OAUTH_CLIENT_SECRET: z.string().min(1),
  OAUTH_REDIRECT_PATH: z.string().startsWith('/').default('/api/v1/auth/github/callback'),

  /**
   * The one browser origin allowed to send session cookies.
   *
   * Deliberately a single explicit value, never '*': with credentials enabled the
   * browser rejects a wildcard response, and a wildcard that did work would let
   * any site attach a user's cookie to its requests.
   */
  PORTAL_WEB_ORIGIN: z.string().url().default('http://localhost:5175'),

  /**
   * NOT `z.coerce.boolean()`: coercion uses Boolean(value), and Boolean('false')
   * is true, so an env var set to the string "false" would silently enable secure
   * cookies. Enumerating the accepted text makes a typo fail at boot instead.
   */
  COOKIE_SECURE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
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
