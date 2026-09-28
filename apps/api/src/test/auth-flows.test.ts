import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ERROR_CODES } from 'shared'
import { buildApp } from '../app.js'
import { loadConfig } from '../config/index.js'
import { startOAuthStub, type OAuthStub, type StubBehaviour } from './fake-oauth.js'
import { waitForRedis } from './wait-for-redis.js'

/**
 * End-to-end against a local stub provider, following real redirects.
 *
 * The stub exists for the failure half: a code redeemed twice, a 401 from the
 * token endpoint, a 200 carrying no access_token, a profile with no login.
 * github.com will not produce those on demand, and they are exactly where a
 * hand-written code flow goes wrong. Because the provider base URL comes from
 * config, both runs exercise the same client code.
 */
let stub: OAuthStub
let app: FastifyInstance

/** Captures everything the app logs, for the leak assertions. */
const logged: string[] = []
const logStream = {
  write(chunk: string) {
    logged.push(String(chunk))
  },
} as unknown as NodeJS.WritableStream

const pristine: StubBehaviour = {
  tokenStatus: 200,
  tokenBody: { access_token: 'provider-token-1' },
  userStatus: 200,
  user: { login: 'stub-user', name: 'Stub User', avatar_url: 'https://avatar.example/a.png' },
  emails: [{ email: 'primary@example.com', primary: true, verified: true }],
  reuseCode: false,
}

beforeAll(async () => {
  if (process.env.DATABASE_URL === undefined || process.env.REDIS_URL === undefined) {
    throw new Error('DATABASE_URL and REDIS_URL are required for auth flow tests')
  }

  stub = await startOAuthStub()

  // Configuration is parsed once at boot, so the stub URL must be in place first.
  process.env.OAUTH_BASE_URL = stub.url
  process.env.API_PUBLIC_URL = 'http://localhost:3001'

  // Log to a buffer so the credential-leak assertions below can inspect what the
  // service would have written in production.
  app = await buildApp({ config: loadConfig(), loggerDestination: logStream as never })
  await waitForRedis(app)
})

afterEach(() => {
  stub.setBehaviour(pristine)
})

afterAll(async () => {
  await app?.db.query('delete from users where github_login = $1', ['stub-user'])
  await app?.close()
  await stub?.close()
})

async function login(returnTo?: string): Promise<{
  statusCode: number
  location: string
  cookies: string[]
}> {
  const start = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/github/start${returnTo === undefined ? '' : `?return_to=${encodeURIComponent(returnTo)}`}`,
  })

  const authorizeUrl = start.headers.location as string
  // Ask the stub what it would send the browser back with, then follow it.
  const providerResponse = await fetch(authorizeUrl, { redirect: 'manual' })
  const callbackUrl = providerResponse.headers.get('location')

  if (callbackUrl === null) throw new Error('stub provider returned no redirect')

  const target = new URL(callbackUrl)
  const response = await app.inject({ method: 'GET', url: `${target.pathname}${target.search}` })

  return {
    statusCode: response.statusCode,
    location: (response.headers.location as string | undefined) ?? '',
    cookies: (response.headers['set-cookie'] as string[] | undefined) ?? [],
  }
}

/** Starts a login but returns the callback URL without following it. */
async function beginLogin(): Promise<{ authorizeUrl: string }> {
  const start = await app.inject({ method: 'GET', url: '/api/v1/auth/github/start' })
  return { authorizeUrl: start.headers.location as string }
}

function cookie(cookies: string[], name: string): string {
  const found = cookies.find((entry) => entry.startsWith(`${name}=`))
  if (found === undefined) throw new Error(`no ${name} cookie set; got ${JSON.stringify(cookies)}`)
  return found.split(';')[0]!
}

function rawCookieHeader(cookies: string[], ...names: string[]): string {
  return names.map((name) => cookie(cookies, name)).join('; ')
}

describe('login', () => {
  it('redirects to the provider carrying a state and our callback', async () => {
    const start = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/github/start?return_to=/blog/x',
    })

    expect(start.statusCode).toBe(302)
    const location = new URL(start.headers.location as string)

    expect(location.pathname).toBe('/login/oauth/authorize')
    expect(location.searchParams.get('state')).toMatch(/^[0-9a-f-]{36}$/)
    expect(location.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3001/api/v1/auth/github/callback',
    )
  })

  it('sets both cookies with the agreed attributes', async () => {
    const result = await login('/blog/x')

    expect(result.statusCode).toBe(302)
    expect(result.location).toBe('/blog/x')

    const access = result.cookies.find((c) => c.startsWith('portal_access=')) ?? ''
    const refresh = result.cookies.find((c) => c.startsWith('portal_refresh=')) ?? ''

    expect(access).toMatch(/HttpOnly/i)
    expect(access).toMatch(/SameSite=Lax/i)
    expect(refresh).toMatch(/SameSite=Strict/i)
    // The narrow path is what keeps the long-lived credential out of unrelated
    // requests, logs and upstreams.
    expect(refresh).toMatch(/Path=\/api\/v1\/auth/i)
  })

  it('establishes a session that /auth/me accepts via the cookie', async () => {
    const { cookies } = await login()

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: cookie(cookies, 'portal_access') },
    })

    expect(me.statusCode).toBe(200)
    expect(me.json().user.login).toBe('stub-user')
    expect(me.json().user.isAdmin).toBe(false)
  })

  /**
   * Writing is_admin on the upsert's update branch would silently demote an admin
   * the next time they signed in — a bug that shows up as nothing at all.
   */
  it('does not reset is_admin on a repeat login', async () => {
    await login()
    await app.db.query('update users set is_admin = true where github_login = $1', ['stub-user'])

    await login()

    const { rows } = await app.db.query<{ is_admin: boolean }>(
      'select is_admin from users where github_login = $1',
      ['stub-user'],
    )
    expect(rows[0]!.is_admin).toBe(true)

    await app.db.query('update users set is_admin = false where github_login = $1', ['stub-user'])
  })

  it('rejects a second callback carrying the same state', async () => {
    const { authorizeUrl } = await beginLogin()
    const state = new URL(authorizeUrl).searchParams.get('state')!
    const url = `/api/v1/auth/github/callback?code=code-1&state=${state}`

    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(302)

    const second = await app.inject({ method: 'GET', url })
    expect(second.statusCode).toBe(400)
    expect(second.json().error.code).toBe(ERROR_CODES.invalidState)
  })

  it('rejects an unknown state without contacting the provider', async () => {
    const redeemedBefore = stub.redeemedCodes().length

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/github/callback?code=code-9&state=never-issued',
    })

    expect(response.statusCode).toBe(400)
    // Consuming state first means a forged callback cannot burn a valid code.
    expect(stub.redeemedCodes()).toHaveLength(redeemedBefore)
  })

  it('reports a provider-side denial distinctly', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/github/callback?error=access_denied&state=whatever',
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe(ERROR_CODES.oauthDenied)
  })

  it.each([
    ['a 401 token response', { tokenStatus: 401 } as Partial<StubBehaviour>, ERROR_CODES.oauthExchangeFailed],
    ['a token response with no access_token', { tokenStatus: 200, tokenBody: {} } as Partial<StubBehaviour>, ERROR_CODES.oauthExchangeFailed],
    ['a profile without a login', { user: {} } as Partial<StubBehaviour>, ERROR_CODES.oauthProfileFailed],
    ['a failed profile response', { userStatus: 500 } as Partial<StubBehaviour>, ERROR_CODES.oauthProfileFailed],
  ])('turns %s into a 502 with a project code', async (_label, behaviour, code) => {
    stub.setBehaviour(behaviour)
    const { authorizeUrl } = await beginLogin()
    const state = new URL(authorizeUrl).searchParams.get('state')!

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github/callback?code=secret-code-value&state=${state}`,
    })

    expect(response.statusCode).toBe(502)
    expect(response.json().error.code).toBe(code)
    // Provider detail never reaches the client: the body can echo the code back.
    expect(response.body).not.toContain('secret-code-value')
  })

  it.each([
    ['protocol-relative', '//evil.example/pwned'],
    ['backslash trick', '/\\evil.example'],
    ['absolute url', 'https://evil.example'],
    ['scheme-relative with query', '/	//evil.example'],
  ])('falls back to / for a %s return_to', async (_label, attempted) => {
    const result = await login(attempted)

    // An open redirect here is a phishing link served from this domain.
    expect(result.statusCode).toBe(302)
    expect(result.location).toBe('/')
  })

  /**
   * The boundary of what this function is for.
   *
   * A same-site relative path that merely *carries* a URL in its query is passed
   * through unchanged — rejecting it would break legitimate deep links, and the
   * destination page owns interpreting its own parameters. The guard stops the
   * login redirect from leaving this site; it does not audit whatever
   * `/redirect?to=...` later decides to do with `to`.
   */
  it('passes through a same-site path that carries a URL in its query', async () => {
    const benign = '/redirect?to=https%3A%2F%2Fexample.org'
    const { response, location } = await loginAndInspect(benign)

    expect(response.statusCode).toBe(302)
    expect(location).toBe(benign)
  })

  async function loginAndInspect(returnTo: string) {
    const start = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github/start?return_to=${encodeURIComponent(returnTo)}`,
    })
    const providerResponse = await fetch(start.headers.location as string, { redirect: 'manual' })
    const target = new URL(providerResponse.headers.get('location')!)
    const response = await app.inject({ method: 'GET', url: `${target.pathname}${target.search}` })

    return { response, location: (response.headers.location as string) ?? '' }
  }
})

/**
 * Credentials must never reach the log.
 *
 * Logs get shipped, indexed and retained by systems with a much wider audience
 * than the database. A refresh token there is a live 30-day credential for anyone
 * with log access, and the JWT_SECRET would hand over the ability to mint any
 * session. Neither is visible in any other test.
 */
describe('log hygiene', () => {
  it('does not log the refresh token, the JWT secret, or the provider code', async () => {
    const before = logged.length
    const { cookies } = await login()
    const refreshValue = cookie(cookies, 'portal_refresh').split('=')[1]!
    const accessValue = cookie(cookies, 'portal_access').split('=')[1]!

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: `portal_refresh=${refreshValue}`, 'x-requested-with': 'portal' },
    })

    const output = logged.slice(before).join('')

    expect(output).not.toContain(refreshValue)
    expect(output).not.toContain(configSecret)
    // The OAuth code is single-use, but logging it would still expose a
    // just-spent credential to anyone reading logs.
    expect(output).not.toContain('provider-token-1')
    expect(accessValue.length).toBeGreaterThan(0)
  })
})

const configSecret = loadConfig().JWT_SECRET

describe('CSRF guard', () => {
  it('refuses a state-changing auth call with no custom header', async () => {
    const { cookies } = await login()

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: cookie(cookies, 'portal_refresh') },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe(ERROR_CODES.csrfCheckFailed)
  })

  it('accepts the identical call once the header is present', async () => {
    const { cookies } = await login()

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: cookie(cookies, 'portal_refresh'), 'x-requested-with': 'portal' },
    })

    expect(response.statusCode).toBe(204)
  })
})

describe('refresh and logout', () => {
  it('rotates the refresh cookie and rejects the spent value', async () => {
    const { cookies } = await login()
    const original = cookie(cookies, 'portal_refresh')

    const renewed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: original, 'x-requested-with': 'portal' },
    })
    expect(renewed.statusCode).toBe(200)

    const rotatedCookies = (renewed.headers['set-cookie'] as string[] | undefined) ?? []
    const replacement = cookie(rotatedCookies, 'portal_refresh')
    expect(replacement).not.toBe(original)

    // Replaying the spent token fails, and takes the replacement with it.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: original, 'x-requested-with': 'portal' },
    })
    expect(replay.statusCode).toBe(401)

    const afterReplay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: replacement, 'x-requested-with': 'portal' },
    })
    expect(afterReplay.statusCode).toBe(401)
  })

  /**
   * What a cookie-clearing logout would silently miss: a bearer token copied
   * before logout must stop working now, not at its 15-minute expiry.
   */
  it('logout revokes the access token immediately', async () => {
    const { cookies } = await login()
    const access = cookie(cookies, 'portal_access')

    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: access },
    })
    expect(before.statusCode).toBe(200)

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: rawCookieHeader(cookies, 'portal_access', 'portal_refresh'),
        'x-requested-with': 'portal',
      },
    })

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: access },
    })
    expect(after.statusCode).toBe(401)
  })

  it('succeeds when logging out with already-dead credentials', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: 'portal_refresh=nonsense', 'x-requested-with': 'portal' },
    })

    // Someone unable to log out is worse than a logout that had nothing to do.
    expect(response.statusCode).toBe(204)
  })
})
