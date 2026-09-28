import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const sha256hex = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex')
import { Pool } from 'pg'
import { loadConfig } from '../config/index.js'
import {
  InvalidTokenError,
  RefreshTokenError,
  TokenReuseError,
  TokenStore,
} from '../modules/auth/token-store.js'

/**
 * Integration against real Postgres: rotation and reuse detection are entirely
 * about row state across statements, so a double would test the mock.
 */
let pool: Pool
let store: TokenStore
let userId: string

beforeAll(async () => {
  if (process.env.DATABASE_URL === undefined) {
    throw new Error('DATABASE_URL is required for token-store integration tests')
  }
  pool = new Pool({ connectionString: loadConfig().DATABASE_URL })
  store = new TokenStore(pool, 30)

  const { rows } = await pool.query(
    `insert into users (github_login, display_name)
       values ('token-store-fixture', 'Fixture')
       returning id`,
  )
  userId = rows[0]!.id
})

afterAll(async () => {
  if (userId !== undefined) {
    await pool.query('delete from users where id = $1', [userId])
  }
  await pool?.end()
})

describe('issue and rotate', () => {
  it('returns a fresh token whose replacement carries the same family', async () => {
    const first = await store.issue(userId)
    const second = await store.rotate(first.raw)

    expect(second.raw).not.toBe(first.raw)
    expect(second.familyId).toBe(first.familyId)
    expect(second.userId).toBe(userId)

    // The replacement is itself spendable once.
    const third = await store.rotate(second.raw)
    expect(third.familyId).toBe(first.familyId)
  })

  it('stores only the hash — a dump must not contain usable tokens', async () => {
    const issued = await store.issue(userId)

    const { rows } = await pool.query<{ token_hash: string }>(
      'select token_hash from refresh_tokens where id = $1',
      [issued.tokenId],
    )

    expect(rows[0]!.token_hash).not.toContain(issued.raw)
    // The stored value must be exactly the hash we compute, i.e. reversible by
    // brute force only against a 256-bit space.
    expect(rows[0]!.token_hash).toBe(sha256hex(issued.raw))

    await pool.query('delete from refresh_tokens where family_id = $1', [issued.familyId])
  })
})

describe('reuse detection', () => {
  it('rejects a rotated-away token and revokes the entire family', async () => {
    const first = await store.issue(userId)
    const replacement = await store.rotate(first.raw)

    // Replay the spent value: the signal that somebody kept a copy.
    await expect(store.rotate(first.raw)).rejects.toBeInstanceOf(TokenReuseError)

    /**
     * The point of the whole mechanism: the *legitimate* holder is logged out too.
     *
     * Anything less means a stolen token keeps working while the real session is
     * unknown to us, which is the opposite of what detection is for.
     *
     * Asserted against the base class on purpose: the replacement is itself a
     * revoked row, so it re-triggers reuse rather than plain invalidity. Both are
     * 401 at the boundary, and pinning the concrete class here would encode an
     * implementation detail as a requirement.
     */
    await expect(store.rotate(replacement.raw)).rejects.toBeInstanceOf(RefreshTokenError)

    const { rows } = await pool.query<{ live: string }>(
      `select count(*)::text as live from refresh_tokens
         where family_id = $1 and revoked_at is null`,
      [first.familyId],
    )
    expect(rows[0]!.live).toBe('0')
  })

  it('does not touch other families of the same user', async () => {
    const chainA = await store.issue(userId)
    const chainB = await store.issue(userId)

    const rotated = await store.rotate(chainA.raw)
    await expect(store.rotate(chainA.raw)).rejects.toBeInstanceOf(TokenReuseError)

    // `rotated` is family A's replacement: revoking the chain must reach it too.
    await expect(store.rotate(rotated.raw)).rejects.toBeInstanceOf(RefreshTokenError)

    // B is a separate login (another device) and must be untouched. Without this
    // half the assertion, "revoke everything for the user" would pass the test.
    await expect(store.rotate(chainB.raw)).resolves.toBeDefined()
  })
})

describe('invalid input', () => {
  it('rejects an unknown token without distinguishing it from an expired one', async () => {
    await expect(store.rotate('totally-made-up-value')).rejects.toBeInstanceOf(InvalidTokenError)
  })

  it('rejects an expired token', async () => {
    const issued = await store.issue(userId)
    await pool.query(
      `update refresh_tokens set expires_at = now() - interval '1 minute' where id = $1`,
      [issued.tokenId],
    )

    await expect(store.rotate(issued.raw)).rejects.toBeInstanceOf(InvalidTokenError)
  })
})

describe('revocation', () => {
  it('revoke(raw) spends just that token', async () => {
    const issued = await store.issue(userId)
    await store.revoke(issued.raw)

    await expect(store.rotate(issued.raw)).rejects.toBeInstanceOf(TokenReuseError)
  })

  it('revokeAllForUser spends every live token across families', async () => {
    const a = await store.issue(userId)
    const b = await store.issue(userId)

    const count = await store.revokeAllForUser(userId)
    expect(count).toBeGreaterThanOrEqual(2)

    await expect(store.rotate(a.raw)).rejects.toBeInstanceOf(TokenReuseError)
    await expect(store.rotate(b.raw)).rejects.toBeInstanceOf(TokenReuseError)
  })
})
