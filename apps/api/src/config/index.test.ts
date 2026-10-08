import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from './index.js'

const validEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/myblog',
  REDIS_URL: 'redis://localhost:6379',
  // S2 made these required; a test env that omits them fails for the wrong
  // reason, so the fixture states them explicitly rather than relying on defaults.
  JWT_SECRET: 'x'.repeat(43),
  OAUTH_CLIENT_ID: 'test-client-id',
  OAUTH_CLIENT_SECRET: 'test-client-secret',
  // S3 stage F made these five required for the same reason, and the same trap
  // applies twice over: omitted here they fail these tests, and omitted from
  // ci.yml's `env:` block they fail every integration suite in CI only.
  MEDIA_ENDPOINT: 'http://127.0.0.1:9000',
  MEDIA_BUCKET: 'test-media',
  MEDIA_ACCESS_KEY_ID: 'test-access-key',
  MEDIA_SECRET_ACCESS_KEY: 'test-secret-key',
  MEDIA_PUBLIC_BASE_URL: 'http://127.0.0.1:9000/test-media',
}

describe('loadConfig', () => {
  it('applies defaults for optional values', () => {
    const config = loadConfig(validEnv)

    expect(config.NODE_ENV).toBe('development')
    expect(config.PORT).toBe(3001)
    expect(config.LOG_LEVEL).toBe('info')

    // The media tuning knobs are the ones with defaults, and their exact values are
    // contract: 5 MiB is the size the docs and the tests both quote, 60 s is the
    // signature window, and a region that disagreed with MinIO's own default would
    // break signing rather than boot.
    expect(config.MEDIA_REGION).toBe('us-east-1')
    expect(config.MEDIA_MAX_UPLOAD_BYTES).toBe(5 * 1024 * 1024)
    expect(config.MEDIA_PRESIGN_TTL_SECONDS).toBe(60)

    // S6-R7's two ceilings, asserted at their exact values because the numbers are
    // the deliverable: 60 is the figure that lets an admin's 12-image import and
    // this suite's own writes through, and 10 is the anonymous login door. A silent
    // change to either is a change to what the API refuses in production.
    expect(config.RATE_LIMIT_WRITE_PER_MINUTE).toBe(60)
    expect(config.RATE_LIMIT_ANON_PER_MINUTE).toBe(10)
  })

  /**
   * The CI contract, tested rather than commented.
   *
   * `conventions.md` §10 records twice now — once for missing keys, once for
   * present ones — that whatever `loadConfig` demands, CI must supply. S6-R7 chose
   * defaults for exactly that reason, and the choice is only real if an env with
   * neither key still parses. If this test ever goes red because someone moved a
   * limit to required, `.github/workflows/ci.yml`'s `env:` block is part of the
   * same change and the suite will stay green here while failing only in CI.
   */
  it('needs no rate-limit keys to boot, so CI gains no new contract', () => {
    // `validEnv` above carries neither key, so reaching this line at all is the
    // assertion; the parse would have thrown in the line before it otherwise.
    const bare = loadConfig(validEnv)
    expect(bare.RATE_LIMIT_WRITE_PER_MINUTE).toBe(60)
    expect(bare.RATE_LIMIT_ANON_PER_MINUTE).toBe(10)

    // Overridable, and still a validated number rather than a string that reaches
    // the counter arithmetic. `''` coerces to 0, which `min(1)` refuses: a limit of
    // zero would 429 every write, and that must be a boot failure, not an outage.
    expect(loadConfig({ ...validEnv, RATE_LIMIT_WRITE_PER_MINUTE: '500' }).RATE_LIMIT_WRITE_PER_MINUTE).toBe(500)
    expect(() => loadConfig({ ...validEnv, RATE_LIMIT_WRITE_PER_MINUTE: '0' })).toThrowError(ConfigError)
    expect(() => loadConfig({ ...validEnv, RATE_LIMIT_ANON_PER_MINUTE: '' })).toThrowError(ConfigError)
  })

  it('coerces PORT from its string form', () => {
    // Environment variables are always strings; the schema is responsible for
    // turning them into the types the rest of the app expects.
    expect(loadConfig({ ...validEnv, PORT: '4000' }).PORT).toBe(4000)
  })

  it('reports every problem at once rather than only the first', () => {
    // This is the entire reason config is validated up front: one restart should
    // reveal every missing variable, not one per restart.
    let message = ''
    try {
      loadConfig({})
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      message = (error as Error).message
    }

    expect(message).toContain('DATABASE_URL')
    expect(message).toContain('REDIS_URL')
    // The credentials are in this list because they have *no* default, which is the
    // only thing that makes a missing one a boot failure instead of a 500 on the first
    // upload. A defaulted secret would silently ship as the project's media password.
    expect(message).toContain('MEDIA_ACCESS_KEY_ID')
    expect(message).toContain('MEDIA_SECRET_ACCESS_KEY')
    expect(message).toContain('MEDIA_ENDPOINT')
    expect(message).toContain('MEDIA_BUCKET')
    expect(message).toContain('MEDIA_PUBLIC_BASE_URL')
  })

  it('refuses an unusable media bound rather than trusting convention', () => {
    // A 0-byte cap would reject every upload; a TTL of a day would leave a write
    // capability in the wild long after the editor closed. Both are bounds the schema
    // owns, so a typo in `.env` fails at boot with a named key.
    expect(() => loadConfig({ ...validEnv, MEDIA_MAX_UPLOAD_BYTES: '0' })).toThrowError(ConfigError)
    expect(() => loadConfig({ ...validEnv, MEDIA_PRESIGN_TTL_SECONDS: '0' })).toThrowError(ConfigError)
    expect(() => loadConfig({ ...validEnv, MEDIA_PRESIGN_TTL_SECONDS: '3600' })).toThrowError(ConfigError)
    expect(() => loadConfig({ ...validEnv, MEDIA_ENDPOINT: 'not-a-url' })).toThrowError(ConfigError)
    expect(() => loadConfig({ ...validEnv, MEDIA_BUCKET: '' })).toThrowError(ConfigError)
  })

  it('rejects a malformed URL', () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: 'not-a-url' })).toThrowError(ConfigError)
  })

  it('rejects a non-numeric PORT', () => {
    expect(() => loadConfig({ ...validEnv, PORT: 'abc' })).toThrowError(ConfigError)
  })

  it('rejects an unknown LOG_LEVEL', () => {
    expect(() => loadConfig({ ...validEnv, LOG_LEVEL: 'verbose' })).toThrowError(ConfigError)
  })
})
