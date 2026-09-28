import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from '@fastify/jwt'
import { ERROR_CODES } from 'shared'
import { buildApp } from '../app.js'
import { loadConfig } from '../config/index.js'
import { requireAdmin } from '../modules/auth/guards.js'
import { requireAuth } from '../plugins/auth.js'
import { generateJti } from '../lib/tokens.js'

/**
 * Authorisation tests — the "prove a bug is actually closed" file.
 *
 * requireAdmin is exercised against routes registered *here*, not against a
 * product endpoint: S2 deliberately has no admin HTTP surface (the admin users
 * API was cut in planning). That is recorded as a known limitation in prd.md —
 * end-to-end 403 coverage arrives with S3's admin write routes — rather than
 * papered over by inventing a route that exists only to be tested.
 */
let app: FastifyInstance
const config = loadConfig()

const users: { admin: string; plain: string } = { admin: '', plain: '' }

function tokenFor(userId: string): string {
  return app.signAccessToken({ sub: userId, jti: generateJti() })
}

beforeAll(async () => {
  if (process.env.DATABASE_URL === undefined || process.env.REDIS_URL === undefined) {
    throw new Error('DATABASE_URL and REDIS_URL are required for authorisation tests')
  }

  app = await buildApp({ config })

  // Test-only surfaces so the guards have something to guard.
  app.get('/test/whoami', { onRequest: [requireAuth] }, async (request) => ({
    sub: request.auth?.sub ?? null,
  }))
  app.get('/test/admin', { onRequest: [requireAdmin] }, async () => ({ ok: true }))

  const inserted = await app.db.query<{ id: string; github_login: string }>(
    `insert into users (github_login, display_name, is_admin)
       values ('authz-admin', 'A', true), ('authz-plain', 'P', false)
       returning id, github_login`,
  )
  for (const row of inserted.rows) {
    if (row.github_login === 'authz-admin') users.admin = row.id
    else users.plain = row.id
  }
})

afterAll(async () => {
  // Runs even when an assertion failed mid-test, which is the whole point of
  // putting cleanup here instead of at the end of a test body.
  await app?.db.query(
    `delete from users
       where github_login in ('authz-admin', 'authz-plain', 'authz-impersonator', 'authz-ghost')`,
  )
  await app?.close()
})

function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

describe('requireAuth', () => {
  it('accepts a token minted through the single signing path', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test/whoami',
      headers: authHeader(tokenFor(users.plain)),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().sub).toBe(users.plain)
  })

  it('rejects a request with no credentials at all', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/whoami' })

    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe(ERROR_CODES.unauthorized)
  })

  it('rejects a tampered payload with the same 401 as garbage', async () => {
    const token = tokenFor(users.plain)
    const [header, payload, signature] = token.split('.')
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: users.admin }),
    ).toString('base64url')

    const response = await app.inject({
      method: 'GET',
      url: '/test/whoami',
      headers: authHeader(`${header}.${forged}.${signature}`),
    })

    // Same code as the no-credentials case: which guess failed is not the
    // caller's business.
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe(ERROR_CODES.unauthorized)
  })

  it('rejects alg:none', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({ sub: users.admin, jti: generateJti(), exp: Math.floor(Date.now() / 1000) + 900 }),
    ).toString('base64url')

    const response = await app.inject({
      method: 'GET',
      url: '/test/whoami',
      headers: authHeader(`${header}.${payload}.`),
    })

    expect(response.statusCode).toBe(401)
  })

  it('rejects a token signed with a different secret', async () => {
    const foreign = Fastify({ logger: false })
    await foreign.register(jwt, { secret: 'z'.repeat(43) })
    const token = foreign.jwt.sign({ sub: users.admin, jti: generateJti() }, { expiresIn: 900 })
    await foreign.close()

    const response = await app.inject({
      method: 'GET',
      url: '/test/whoami',
      headers: authHeader(token),
    })

    expect(response.statusCode).toBe(401)
  })

  it('rejects an expired token', async () => {
    const token = app.jwt.sign({ sub: users.plain, jti: generateJti() }, { expiresIn: -1 })

    const response = await app.inject({
      method: 'GET',
      url: '/test/whoami',
      headers: authHeader(token),
    })

    expect(response.statusCode).toBe(401)
  })

  /**
   * Guards the property @fastify/jwt does not provide: it accepts a token with no
   * exp even when maxAge is passed, so the TTL exists only because
   * signAccessToken always attaches one. A token reaching this path means
   * something signed outside that function.
   */
  it('rejects a token that bypassed the single signing path and has no exp', async () => {
    const eternal = app.jwt.sign({ sub: users.admin, jti: generateJti() })

    const response = await app.inject({
      method: 'GET',
      url: '/test/whoami',
      headers: authHeader(eternal),
    })

    expect(response.statusCode).toBe(401)
  })

  it('rejects a logged-out token immediately, not at expiry', async () => {
    const jti = generateJti()
    const token = app.signAccessToken({ sub: users.plain, jti })

    expect((await app.inject({ method: 'GET', url: '/test/whoami', headers: authHeader(token) })).statusCode)
      .toBe(200)

    await app.denylist.revoke(jti, config.ACCESS_TOKEN_TTL_SECONDS)

    expect((await app.inject({ method: 'GET', url: '/test/whoami', headers: authHeader(token) })).statusCode)
      .toBe(401)
  })
})

describe('requireAdmin', () => {
  it('refuses an authenticated non-admin with 403', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test/admin',
      headers: authHeader(tokenFor(users.plain)),
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe(ERROR_CODES.forbidden)
  })

  it('admits an authenticated admin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test/admin',
      headers: authHeader(tokenFor(users.admin)),
    })

    expect(response.statusCode).toBe(200)
  })

  it('answers 401 for a valid token whose account was deleted', async () => {
    const { rows } = await app.db.query<{ id: string }>(
      `insert into users (github_login, display_name, is_admin)
         values ('authz-ghost', 'G', true) returning id`,
    )
    const ghostId = rows[0]!.id
    const token = tokenFor(ghostId)

    await app.db.query('delete from users where id = $1', [ghostId])

    const response = await app.inject({
      method: 'GET',
      url: '/test/admin',
      headers: authHeader(token),
    })

    // Gone-account is 401, not 403: the identity no longer exists, so there is no
    // rights question to answer.
    expect(response.statusCode).toBe(401)
  })
})

/**
 * Regression for defect D1, kept permanently.
 *
 * D1 was: RLS decided admin-ness from `user_metadata`, which the signed-in user
 * can rewrite with supabase.auth.updateUser(). Anyone could name themselves the
 * admin and gain write access to every article.
 */
describe('D1 regression: nothing a user can write grants anything', () => {
  it('a plain user who looks exactly like the admin still gets 403', async () => {
    // Same display name as the admin; different row, different is_admin.
    //
    // Upsert, not plain insert: a row left behind by an earlier run that failed
    // partway must not make this test fail on a unique violation. Cleanup living
    // after an assertion is exactly what a failure skips — see the afterAll hook.
    const { rows } = await app.db.query<{ id: string }>(
      `insert into users (github_login, display_name, is_admin)
         values ('authz-impersonator', 'A', false)
       on conflict (github_login) do update
         set display_name = excluded.display_name, is_admin = false
       returning id`,
    )
    const impersonator = rows[0]!.id

    const response = await app.inject({
      method: 'GET',
      url: '/test/admin',
      headers: authHeader(tokenFor(impersonator)),
    })

    expect(response.statusCode).toBe(403)
    expect(impersonator).not.toBe(users.admin)
  })

  it('no backend source consults user_metadata at all', async () => {
    // The cheap structural guard: if anyone reintroduces a self-writable claim as
    // an authorisation input, this fails before it can reach a review.
    const { execFileSync } = await import('node:child_process')
    let hits = ''

    let status = 0
    try {
      hits = execFileSync('git', ['grep', '-n', 'user_metadata', '--', 'apps/api/src'], {
        encoding: 'utf8',
      })
    } catch (error) {
      // git grep exits 1 for "no matches" — the passing case. Anything else
      // (git missing, not a repo, bad cwd) must fail the test rather than be
      // swallowed as a pass, or this assertion proves nothing.
      const { status: code, stderr } = error as { status?: number; stderr?: string }
      if (code !== 1) {
        // cause attached: a wrapped error without it loses the original stack in
        // the log, which is the only thing that explains a broken harness.
        throw new Error(`user_metadata grep could not run (status ${code}): ${stderr ?? ''}`, {
          cause: error,
        })
      }
      status = code
    }

    expect(status, 'grep must run; a swallowed error is not a pass').toBe(1)
    expect(hits.trim()).toBe('')
  })
})

describe('GET /api/v1/auth/me', () => {
  it('reports isAdmin from the database, per request', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authHeader(tokenFor(users.plain)),
    })
    expect(before.json().user.isAdmin).toBe(false)

    await app.db.query('update users set is_admin = true where id = $1', [users.plain])

    // Same token, next request: revocation takes effect immediately because the
    // flag is read fresh rather than baked into the token.
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authHeader(tokenFor(users.plain)),
    })
    expect(after.json().user.isAdmin).toBe(true)

    await app.db.query('update users set is_admin = false where id = $1', [users.plain])
  })

  it('401s without credentials', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me' })
    expect(response.statusCode).toBe(401)
  })
})
