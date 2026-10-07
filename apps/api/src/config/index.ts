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
   * This service's own externally reachable origin.
   *
   * Needed to build redirect_uri, which GitHub matches character-for-character
   * against the registered callback. Deliberately configured rather than derived
   * from the Host header: a spoofed header would send the browser to a callback
   * URL on an attacker's host, and the code would land there.
   */
  API_PUBLIC_URL: z.string().url().default('http://localhost:3001'),

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

  // ── Media object storage (S3 stage F, design §4.2/§4.3) ──────────────────────
  //
  // REQUIRED keys: MEDIA_ENDPOINT, MEDIA_BUCKET, MEDIA_ACCESS_KEY_ID,
  // MEDIA_SECRET_ACCESS_KEY, MEDIA_PUBLIC_BASE_URL.
  //
  // The two credentials have no default by the same rule that keeps `JWT_SECRET`
  // un-defaulted: a default secret is a credential committed to the repository, and
  // a missing one must stop the process at boot rather than surface as a 500 on the
  // first upload. The endpoint, bucket and public base are required too, even
  // though "obviously" they are localhost:9000 and portal-media — because that
  // reasoning is exactly how a production deploy that forgot the variable ends up
  // dialling a host that does not exist, hours after boot, on a user-visible
  // request. `DATABASE_URL` is required for the same reason; media is not a
  // second-class dependency.
  //
  // CONSEQUENCE, and the reason this paragraph is here rather than in a README:
  // every key marked required is a CI contract. `.github/workflows/ci.yml` sets
  // them in its job-level `env:` block; add a required key without adding it there
  // and every integration file's `beforeAll` dies with a `ConfigError` in CI while
  // staying green on any machine that has an `apps/api/.env`.
  MEDIA_ENDPOINT: z.url(),
  MEDIA_BUCKET: z.string().min(1),
  MEDIA_ACCESS_KEY_ID: z.string().min(1),
  MEDIA_SECRET_ACCESS_KEY: z.string().min(1),

  /**
   * Where a browser reaches the same bucket publicly.
   *
   * Kept separate from `MEDIA_ENDPOINT` on purpose: they differ in production (the
   * API signs against a private endpoint, visitors' `<img>` tags load through a CDN
   * or reverse proxy), and `publicUrl` is built from *this* value only — so a
   * mis-set endpoint can never leak an internal hostname into a page.
   */
  MEDIA_PUBLIC_BASE_URL: z.url(),

  /**
   * Not `auto-discovery`: SigV4 needs a region string even for MinIO, which ignores
   * it as long as the same one is used for signing and for the bucket. `us-east-1`
   * is MinIO's own default, so it is the value that cannot disagree with anything.
   */
  MEDIA_REGION: z.string().min(1).default('us-east-1'),

  /**
   * Hard cap on a stored object, measured by the server after the PUT.
   *
   * 5 MiB is a ceiling for blog cover images, not a target. This number is the one
   * that actually binds: the `size` in an upload request cannot be enforced at
   * signing time because `content-length-range` is a POST-policy condition that
   * presigned PUTs do not have (SPIKE-E hard fact 1).
   */
  MEDIA_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),

  /**
   * How long a signed PUT stays valid. Bounded well below an hour on purpose: the
   * signature grants a write to a bucket whose contents become public, so its
   * lifetime is the window in which anyone holding the URL can replace the object.
   * 60 s covers a cover image on a slow connection and nothing else.
   */
  MEDIA_PRESIGN_TTL_SECONDS: z.coerce.number().int().min(5).max(900).default(60),
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
