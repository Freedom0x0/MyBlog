import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ERROR_CODES } from 'shared'
import { buildApp } from '../app.js'
import { loadConfig } from '../config/index.js'
import { startOAuthStub, type OAuthStub, type StubBehaviour } from './fake-oauth.js'
import { waitForRedis } from './wait-for-redis.js'

/**
 * End-to-end login flows against a local stub provider.
 *
 * The stub exists for the half of this a real provider will not perform on
 * demand: a 401 from the token endpoint, a 200 carrying no access_token, a
 * profile with no id, a state replayed. Those are exactly where a hand-written
 * code flow goes wrong. The provider base URL comes from config, so the test and
 * production runs execute the same client code.
 */

const ADMIN_ID = 4242
const INTRUDER_ID = 9999

const pristine: StubBehaviour = {
  tokenStatus: 200,
  tokenBody: { access_token: 'provider-token-1' },
  userStatus: 200,
  user: { id: ADMIN_ID, login: 'stub-user', name: 'Stub User', avatar_url: 'https://avatar.example/a.png' },
  emails: [{ email: 'primary@example.com', primary: true, verified: true }],
  reuseCode: false,
}

let stub: OAuthStub
let app: FastifyInstance

/** Captures what the service logs, for the credential-leak assertions. */
const logged: string[] = []
const logStream = {
  write(chunk: string) {
    logged.push(String(chunk))
  },
} as unknown as NodeJS.WritableStream

const config = loadConfig()

beforeAll(async () => {
  if (process.env.DATABASE_URL === undefined || process.env.REDIS_URL === undefined) {
    throw new Error('DATABASE_URL and REDIS_URL are required for auth flow tests')
  }

  stub = await startOAuthStub()

  // Config is parsed once at boot, so the stub URL has to be in place first.
  process.env.OAUTH_BASE_URL = stub.url
  process.env.API_PUBLIC_URL = 'http://localhost:3001'

  app = await buildApp({ config: loadConfig(), loggerDestination: logStream })
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

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Fastify sends one Set-Cookie as a string and several as an array, so every read
 * has to normalise. Assuming "always array" made a single-cookie response throw
 * and the whole suite fail, which read like a broken login rather than a broken
 * helper.
 */
function setCookies(headers: Record<string, unknown>): string[] {
  const raw = headers['set-cookie']
  if (raw === undefined) return []
  return (Array.isArray(raw) ? raw : [raw]) as string[]
}

function cookieValue(cookies: string[], name: string): string {
  const found = cookies.find((entry) => entry.startsWith(`${name}=`))
  if (found === undefined) throw new Error(`no ${name} cookie; got ${JSON.stringify(cookies)}`)
  return found.split(';')[0]!
}

interface Driven {
  statusCode: number
  location: string
  cookies: string[]
  body: string
}

/**
 * start → provider → callback, carrying cookies the way a browser would.
 *
 * app.inject() has no cookie jar, so the login nonce has to be forwarded by hand.
 * Passing it is not test scaffolding but part of the protocol: without it the
 * callback must fail.
 */
async function driveLogin(options: {
  returnTo?: string
  /** Omit to prove the callback refuses an unpaired browser. */
  withNonce?: boolean
  /** A callback URL from a different login attempt. */
  overrideCallback?: string
} = {}): Promise<Driven> {
  const { returnTo, withNonce = true, overrideCallback } = options

  const start = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/github/start${returnTo === undefined ? '' : `?return_to=${encodeURIComponent(returnTo)}`}`,
  })

  const authorizeUrl = start.headers.location as string
  const nonceCookie = cookieValue(setCookies(start.headers), 'portal_oauth_nonce')

  const providerResponse = await fetch(authorizeUrl, { redirect: 'manual' })
  const callbackLocation = providerResponse.headers.get('location')
  if (callbackLocation === null) throw new Error('stub provider returned no redirect')

  const target = new URL(overrideCallback ?? callbackLocation)

  const response = await app.inject({
    method: 'GET',
    url: `${target.pathname}${target.search}`,
    headers: withNonce === false ? {} : { cookie: nonceCookie },
  })

  return {
    statusCode: response.statusCode,
    location: (response.headers.location as string | undefined) ?? '',
    cookies: setCookies(response.headers),
    body: response.body,
  }
}

async function login(returnTo?: string): Promise<Driven> {
  return driveLogin({ returnTo })
}

async function loginWithProfile(githubId: number, loginName: string): Promise<Driven> {
  stub.setBehaviour({ user: { id: githubId, login: loginName, name: null, avatar_url: null } })
  return login()
}

/** Signs in and returns the callback URL for that same attempt, for replaying. */
async function captureCallbackUrl(): Promise<string> {
  const start = await app.inject({ method: 'GET', url: '/api/v1/auth/github/start' })
  const providerResponse = await fetch(start.headers.location as string, { redirect: 'manual' })

  return providerResponse.headers.get('location')!
}

// ── login ─────────────────────────────────────────────────────────────────────

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

  it('sets session cookies with the agreed attributes', async () => {
    const result = await login('/blog/x')

    expect(result.statusCode).toBe(302)
    /**
     * Absolute, and pointed at the web origin — this is the defect that survived
     * every previous version of this assertion: comparing the header verbatim
     * accepted `/blog/x`, which a browser resolves against *this API* (3001), so a
     * correct login landed on the API's 404 page. The first real sign-in caught what
     * no inject-based test could.
     */
    expect(result.location).toBe(`${config.PORTAL_WEB_ORIGIN}/blog/x`)
    expect(new URL(result.location).origin).toBe(config.PORTAL_WEB_ORIGIN)

    const access = result.cookies.find((c) => c.startsWith('portal_access=')) ?? ''
    const refresh = result.cookies.find((c) => c.startsWith('portal_refresh=')) ?? ''

    expect(access).toMatch(/HttpOnly/i)
    expect(access).toMatch(/SameSite=Lax/i)
    expect(refresh).toMatch(/SameSite=Strict/i)
    // The narrow path keeps the long-lived credential out of every unrelated
    // request, log line and upstream.
    expect(refresh).toMatch(/Path=\/api\/v1\/auth/i)
  })

  it('establishes a session that /auth/me accepts via the cookie', async () => {
    const { cookies } = await login()

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: cookieValue(cookies, 'portal_access') },
    })

    expect(me.statusCode).toBe(200)
    expect(me.json().user.login).toBe('stub-user')
    expect(me.json().user.isAdmin).toBe(false)
  })

  /**
   * Updating is_admin on the upsert's conflict branch would silently demote an
   * admin at their next sign-in — a bug with no symptom except a missing button.
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
})

// ── login CSRF ────────────────────────────────────────────────────────────────

/**
 * `state` alone is a bearer token: whoever holds it can finish that login. The
 * nonce cookie is what ties the attempt to the browser that started it.
 *
 * Without that pairing an attacker runs `start`, then makes the victim's browser
 * navigate to the resulting callback URL — a top-level GET, which SameSite=Lax
 * permits — and the victim ends up signed in under the *attacker's* identity.
 * Everything they then post belongs to the attacker's account, and the victim has
 * no reason to suspect anything.
 */
describe('login CSRF', () => {
  it('refuses a callback the browser did not start', async () => {
    const result = await driveLogin({ withNonce: false })

    expect(result.statusCode).toBe(400)
    expect(result.body).not.toContain('portal_refresh=')
  })

  it('refuses a nonce from a different login attempt', async () => {
    // Two starts: the second attempt's nonce cannot satisfy the first's state.
    const firstCallback = await captureCallbackUrl()
    const second = await app.inject({ method: 'GET', url: '/api/v1/auth/github/start' })
    const mismatchedNonce = cookieValue(setCookies(second.headers), 'portal_oauth_nonce')

    const target = new URL(firstCallback)
    const response = await app.inject({
      method: 'GET',
      url: `${target.pathname}${target.search}`,
      headers: { cookie: mismatchedNonce },
    })

    expect(response.statusCode).toBe(400)
  })
})

// ── state and code handling ───────────────────────────────────────────────────

describe('state', () => {
  it('rejects a second callback carrying the same state', async () => {
    const start = await app.inject({ method: 'GET', url: '/api/v1/auth/github/start' })
    const nonce = cookieValue(setCookies(start.headers), 'portal_oauth_nonce')
    const state = new URL(start.headers.location as string).searchParams.get('state')!
    const url = `/api/v1/auth/github/callback?code=code-1&state=${state}`

    expect(
      (await app.inject({ method: 'GET', url, headers: { cookie: nonce } })).statusCode,
    ).toBe(302)

    const replay = await app.inject({ method: 'GET', url, headers: { cookie: nonce } })
    expect(replay.statusCode).toBe(400)
    expect(replay.json().error.code).toBe(ERROR_CODES.invalidState)
  })

  it('rejects an unknown state without contacting the provider', async () => {
    const redeemedBefore = stub.redeemedCodes().length

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/github/callback?code=code-9&state=never-issued',
      headers: { cookie: 'portal_oauth_nonce=some-nonce' },
    })

    expect(response.statusCode).toBe(400)
    // State first, provider second: a forged callback must not be able to burn a
    // real code.
    expect(stub.redeemedCodes()).toHaveLength(redeemedBefore)
  })

  it('reports a provider-side denial distinctly', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/github/callback?error=access_denied&state=whatever',
      headers: { cookie: 'portal_oauth_nonce=anything' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe(ERROR_CODES.oauthDenied)
  })
})

describe('provider failures', () => {
  it.each([
    ['a 401 token response', { tokenStatus: 401 } as Partial<StubBehaviour>, ERROR_CODES.oauthExchangeFailed],
    ['a token response without access_token', { tokenStatus: 200, tokenBody: {} } as Partial<StubBehaviour>, ERROR_CODES.oauthExchangeFailed],
    ['a profile without a login', { user: { id: 1 } } as Partial<StubBehaviour>, ERROR_CODES.oauthProfileFailed],
    ['a profile without an id', { user: { login: 'noid' } } as Partial<StubBehaviour>, ERROR_CODES.oauthProfileFailed],
    ['a 500 profile response', { userStatus: 500 } as Partial<StubBehaviour>, ERROR_CODES.oauthProfileFailed],
  ])('turns %s into a 502 with a project code', async (_label, behaviour, code) => {
    stub.setBehaviour(behaviour)

    const result = await login()

    expect(result.statusCode).toBe(502)
    expect(JSON.parse(result.body).error.code).toBe(code)
    // The provider body can echo the code; it never reaches the client.
    expect(result.body).not.toContain('provider-token-1')
  })
})

// ── identity: the squatting regression ────────────────────────────────────────

/**
 * GitHub usernames are mutable, and a released one can be registered by someone
 * else. Keying identity on the login therefore let a stranger be resolved into the
 * previous holder's row — with its `is_admin`.
 *
 * The fix keys on GitHub's immutable numeric id. These are the two directions that
 * matter: a new account with an old name must not inherit anything, and a renamed
 * account must stay itself.
 */
describe('identity is the immutable github id, not the login', () => {
  it('gives a squatted login a fresh row instead of the previous holder\'s', async () => {
    const owner = await login()
    expect(owner.statusCode).toBe(302)
    await app.db.query('update users set is_admin = true where github_login = $1', ['stub-user'])

    // A different person registers the now-released name.
    const intruder = await loginWithProfile(INTRUDER_ID, 'stub-user')
    expect(intruder.statusCode).toBe(302)

    const { rows } = await app.db.query<{ id: string; github_id: string; is_admin: boolean }>(
      `select id, github_id::text, is_admin from users
         where github_login = 'stub-user' order by github_id`,
    )

    // Two distinct rows rather than one merged identity.
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.github_id)).toEqual([String(ADMIN_ID), String(INTRUDER_ID)])
    // The intruder is not an admin; the owner still is.
    expect(rows[1]!.is_admin).toBe(false)
    expect(rows[0]!.is_admin).toBe(true)
  })

  it('follows a renamed account to its own row', async () => {
    await loginWithProfile(ADMIN_ID, 'old-name')
    await app.db.query('update users set is_admin = true where github_id = $1', [ADMIN_ID])

    const renamed = await loginWithProfile(ADMIN_ID, 'stub-user')
    expect(renamed.statusCode).toBe(302)

    const { rows } = await app.db.query<{ is_admin: boolean }>(
      'select is_admin from users where github_id = $1',
      [ADMIN_ID],
    )
    // Same person, same row, privileges intact.
    expect(rows).toHaveLength(1)
    expect(rows[0]!.is_admin).toBe(true)
  })
})

// ── open redirect ─────────────────────────────────────────────────────────────

describe('return_to', () => {
  it.each([
    ['protocol-relative', '//evil.example/pwned'],
    ['backslash trick', '/\\evil.example'],
    ['absolute url', 'https://evil.example'],
    ['tab then protocol-relative', '/\t//evil.example'],
    ['space then protocol-relative', '/ /evil.example'],
    ['CRLF injection', '/a\r\n//evil.example'],
  ])('falls back to / for a %s value', async (_label, attempted) => {
    const result = await login(attempted)

    expect(result.statusCode).toBe(302)
    expect(result.location).toBe(`${config.PORTAL_WEB_ORIGIN}/`)
  })

  /**
   * The boundary of this guard. A same-site relative path that merely carries a URL
   * in its query is passed through: rejecting it would break legitimate deep links,
   * and the destination page owns interpreting its own parameters. The guard stops
   * the login redirect from leaving this site.
   */
  it('passes through a same-site path carrying a URL in its query', async () => {
    const benign = '/redirect?to=https%3A%2F%2Fexample.org'

    // The path passes through unchanged; only the origin is hung in front of it.
    expect((await login(benign)).location).toBe(`${config.PORTAL_WEB_ORIGIN}${benign}`)
  })

  /**
   * Percent-encoded slashes are NOT a bypass, and asserting they are would encode
   * a wrong mental model of URL parsing.
   *
   * Browsers resolve the path before decoding percent-escapes, so
   * `/%2f%2fevil.example` is one literal path segment on this site rather than a
   * protocol-relative URL. Verified independently against Node's WHATWG URL parser
   * (the same algorithm browsers use) — it resolves to this origin.
   */
  it('passes through an encoded-slash path, which does not escape', async () => {
    const encoded = '/%2f%2fevil.example'
    const { location } = await login(encoded)

    expect(location).toBe(`${config.PORTAL_WEB_ORIGIN}${encoded}`)

    /**
     * Judged against the URL the browser is actually handed. The previous version
     * resolved a *relative* Location against a made-up base
     * (`new URL(location, 'https://good.example')`), so it reported "same origin"
     * no matter what — it could not have caught a redirect that resolves against
     * the API instead. An absolute Location makes the claim checkable: still on the
     * web origin, and the encoded slashes stay one literal path segment rather than
     * turning into a protocol-relative URL.
     */
    const resolved = new URL(location)
    expect(resolved.origin).toBe(config.PORTAL_WEB_ORIGIN)
    expect(resolved.pathname).toBe(encoded)
  })
})

// ── CSRF guard on state-changing calls ────────────────────────────────────────

describe('CSRF guard', () => {
  it('refuses a state-changing auth call with no custom header', async () => {
    const { cookies } = await login()

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: cookieValue(cookies, 'portal_refresh') },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe(ERROR_CODES.csrfCheckFailed)
  })

  it('accepts the identical call once the header is present', async () => {
    const { cookies } = await login()

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: cookieValue(cookies, 'portal_refresh'), 'x-requested-with': 'portal' },
    })

    expect(response.statusCode).toBe(204)
  })
})

// ── refresh and logout ────────────────────────────────────────────────────────

describe('refresh and logout', () => {
  it('rotates the refresh cookie and rejects the spent value', async () => {
    const { cookies } = await login()
    const original = cookieValue(cookies, 'portal_refresh')

    const renewed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: original, 'x-requested-with': 'portal' },
    })
    expect(renewed.statusCode).toBe(200)

    const replacement = cookieValue(setCookies(renewed.headers), 'portal_refresh')
    expect(replacement).not.toBe(original)

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: original, 'x-requested-with': 'portal' },
    })
    expect(replay.statusCode).toBe(401)

    // Reuse killed the whole family, so the legitimate replacement is dead too.
    const afterReplay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: replacement, 'x-requested-with': 'portal' },
    })
    expect(afterReplay.statusCode).toBe(401)
  })

  /**
   * What cookie-clearing alone would miss: a bearer token copied before logout has
   * to stop working now, not at its expiry.
   */
  it('logout revokes the access token immediately', async () => {
    const { cookies } = await login()
    const access = cookieValue(cookies, 'portal_access')

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
        cookie: `${access}; ${cookieValue(cookies, 'portal_refresh')}`,
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

    // Someone unable to log out is worse than a logout with nothing to do.
    expect(response.statusCode).toBe(204)
  })
})

// ── log hygiene ───────────────────────────────────────────────────────────────

/**
 * Logs are shipped, indexed and retained by systems with a far wider audience
 * than the database: a refresh token there is a live 30-day credential, and the
 * JWT secret would let anyone mint any session. No other test can see this leak,
 * and by the time it is noticed in production it is everywhere.
 *
 * Mutation-checked: logging a raw refresh token turns this red, so it constrains
 * behaviour rather than passing because nothing was logged.
 */
describe('log hygiene', () => {
  it('does not log the refresh token, the JWT secret, or the provider token', async () => {
    const before = logged.length
    const { cookies } = await login()
    const refreshValue = cookieValue(cookies, 'portal_refresh').split('=')[1]!

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: `portal_refresh=${refreshValue}`, 'x-requested-with': 'portal' },
    })

    const output = logged.slice(before).join('')

    expect(refreshValue.length).toBeGreaterThan(10)
    expect(output).not.toContain(refreshValue)
    expect(output).not.toContain(config.JWT_SECRET)
    expect(output).not.toContain('provider-token-1')
  })
})
