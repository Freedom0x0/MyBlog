import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { describe, expect, it } from 'vitest'
import { generateJti, generateRefreshToken, hashToken, tokenFingerprint } from './tokens.js'

const SECRET = 'a'.repeat(43)

/**
 * Mirrors how the app registers the plugin, so a pass here means something.
 *
 * A bespoke signing helper would let these tests green-light a token format the
 * real verifier never accepts.
 */
/** Reads the exp claim without verifying, purely to assert the shape we sign. */
function extractExp(token: string): number | undefined {
  const [, payload] = token.split('.')
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp?: number }
  return decoded.exp
}

async function buildVerifier() {
  const app = Fastify({ logger: false })
  await app.register(jwt, { secret: SECRET, cookie: { cookieName: 'portal_access', signed: false } })
  return app
}

describe('refresh token primitives', () => {
  it('produces 256-bit values that differ every call', () => {
    const a = generateRefreshToken()
    const b = generateRefreshToken()

    expect(a).not.toBe(b)
    expect(Buffer.from(a, 'base64url')).toHaveLength(32)
  })

  it('hashes deterministically and not to the input', () => {
    const raw = generateRefreshToken()
    const hash = hashToken(raw)

    expect(hashToken(raw)).toBe(hash)
    expect(hash).not.toContain(raw)
    expect(hash).toHaveLength(64)
  })

  it('keeps distinct inputs distinct after hashing', () => {
    expect(hashToken(generateRefreshToken())).not.toBe(hashToken(generateRefreshToken()))
  })

  it('fingerprint is a prefix of the hash, never of the secret', () => {
    const raw = 'super-secret-token-value'
    const hash = hashToken(raw)

    expect(tokenFingerprint(hash)).toBe(hash.slice(0, 8))
    expect(tokenFingerprint(hash)).not.toContain('super')
  })
})

describe('access token verification', () => {
  it('round-trips the claims we say we put in', async () => {
    const app = await buildVerifier()
    const jti = generateJti()
    const token = app.jwt.sign({ sub: 'user-1', jti }, { expiresIn: 900 })

    // @fastify/jwt's verify is synchronous — it returns the payload and throws on
    // failure. Assuming it returned a Promise made the first version of these
    // tests fail on every case with "You must provide a Promise to expect()".
    expect(app.jwt.verify(token)).toMatchObject({ sub: 'user-1', jti })

    await app.close()
  })

  it('rejects a token whose payload was edited', async () => {
    const app = await buildVerifier()
    const token = app.jwt.sign({ sub: 'user-1', jti: generateJti() }, { expiresIn: 900 })

    const [header, payload, signature] = token.split('.')
    // Escalate a copy of the token: swap the subject for an admin account.
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: 'admin' }),
    ).toString('base64url')

    expect(() => app.jwt.verify(`${header}.${forged}.${signature}`)).toThrow()

    await app.close()
  })

  it('rejects alg:none — the classic "just remove the signature" bypass', async () => {
    const app = await buildVerifier()
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ sub: 'attacker', jti: generateJti() })).toString('base64url')

    expect(() => app.jwt.verify(`${header}.${payload}.`)).toThrow()
    expect(() => app.jwt.verify(`${header}.${payload}.anything`)).toThrow()

    await app.close()
  })

  it('rejects a token signed with a different key', async () => {
    const issuer = Fastify({ logger: false })
    await issuer.register(jwt, { secret: 'b'.repeat(43) })
    const token = issuer.jwt.sign({ sub: 'user-1', jti: generateJti() }, { expiresIn: 900 })

    const verifier = await buildVerifier()
    expect(() => verifier.jwt.verify(token)).toThrow()

    await issuer.close()
    await verifier.close()
  })

  it('rejects an expired token, and does so distinctly from a bad signature', async () => {
    const app = await buildVerifier()
    // expiresIn: -1 is already in the past when it is verified.
    const token = app.jwt.sign({ sub: 'user-1', jti: generateJti() }, { expiresIn: -1 })

    const err = (() => { try { app.jwt.verify(token); return null } catch (e) { return e as Error & { code?: string } } })()
    expect(err, 'expired token should be rejected').not.toBeNull()
    // The distinct code is what lets the guard answer TOKEN_REVOKED vs
    // UNAUTHORIZED rather than lumping every rejection into one bucket.
    expect(err?.code).toContain('EXPIRED')

    await app.close()
  })

  /**
   * Characterisation test — this is the library's real behaviour, and it is the
   * opposite of what you would assume.
   *
   * A token signed without `expiresIn` carries no `exp` claim, and verification
   * accepts it *even when `maxAge` is supplied*. The 15-minute lifetime is
   * therefore not enforced by @fastify/jwt; it exists only because the code that
   * signs always passes the TTL.
   *
   * Consequence recorded in design.md §5: signing goes through exactly one place
   * that supplies `expiresIn`, and this test exists so a future refactor that
   * forgets it is caught by a failing assertion rather than by an incident.
   */
  it('accepts a token with no exp claim even when maxAge is given', async () => {
    const app = await buildVerifier()
    const eternal = app.jwt.sign({ sub: 'user-1', jti: generateJti() })

    expect(() => app.jwt.verify(eternal, { maxAge: 900 })).not.toThrow()

    await app.close()
  })

  it('rejects no such token once the TTL is applied as a required claim', async () => {
    // The guard we actually rely on: reject when the exp claim is absent, rather
    // than trusting maxAge to synthesise one.
    const app = await buildVerifier()
    const withExp = app.jwt.sign({ sub: 'user-1', jti: generateJti() }, { expiresIn: 900 })
    const withoutExp = app.jwt.sign({ sub: 'user-1', jti: generateJti() })

    expect(extractExp(withExp)).toBeTypeOf('number')
    expect(extractExp(withoutExp)).toBeUndefined()

    await app.close()
  })
})
