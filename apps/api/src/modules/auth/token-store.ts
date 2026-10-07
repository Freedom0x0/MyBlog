import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { generateRefreshToken, hashToken, tokenFingerprint } from '../../lib/tokens.js'

/**
 * Refresh token storage, rotation and revocation.
 *
 * The invariant this exists to maintain: a refresh token is usable once. Present
 * a spent one and the whole chain it belongs to dies, because a legitimate client
 * discarded it when it rotated — its reappearance means somebody kept a copy.
 */

export interface IssuedToken {
  /** The value handed to the client. Never stored, only its hash. */
  raw: string
  tokenId: string
  familyId: string
  userId: string
  expiresAt: Date
}

/**
 * Common base for every way a presented refresh token can fail.
 *
 * The route maps all of them to the same 401 with the same public code. A
 * different code per cause would tell an attacker which guesses were real, and
 * "unknown", "expired" and "already spent" are exactly the kind of distinction
 * worth hiding: each one confirms something about stored state.
 *
 * Subclasses remain for logs and metrics, where the distinction is useful and
 * costs nothing because the response has already been decided.
 */
export abstract class RefreshTokenError extends Error {}

export class InvalidTokenError extends RefreshTokenError {
  constructor() {
    super('Refresh token is unknown or expired')
    this.name = 'InvalidTokenError'
  }
}

/** A token that was already rotated away: the reuse-detection signal. */
export class TokenReuseError extends RefreshTokenError {
  constructor(readonly familyId: string) {
    super('Refresh token replay detected; family revoked')
    this.name = 'TokenReuseError'
  }
}

interface TokenRow {
  id: string
  user_id: string
  family_id: string
  revoked_at: Date | null
  expires_at: Date
}

export class TokenStore {
  constructor(
    private readonly pool: Pool,
    private readonly refreshTtlDays: number,
  ) {}

  /**
   * Issue a token. `familyId` is omitted for the first token of a login and
   * carried forward by every rotation, which is what makes "revoke the chain" a
   * single statement.
   */
  async issue(userId: string, familyId?: string): Promise<IssuedToken> {
    const raw = generateRefreshToken()
    const family = familyId ?? randomUUID()
    const expiresAt = new Date(Date.now() + this.refreshTtlDays * 24 * 60 * 60 * 1000)

    const { rows } = await this.pool.query<{ id: string }>(
      `insert into refresh_tokens (user_id, token_hash, family_id, expires_at)
         values ($1, $2, $3, $4)
         returning id`,
      [userId, hashToken(raw), family, expiresAt],
    )

    return { raw, tokenId: rows[0]!.id, familyId: family, userId, expiresAt }
  }

  /**
   * Spend `raw` and return its replacement.
   *
   * Runs in one transaction and locks the row while doing so. Without `FOR UPDATE`
   * two concurrent refreshes both read `revoked_at is null`, both insert a child,
   * and both succeed — leaving two live tokens where the invariant promises one,
   * and quietly defeating reuse detection for the pair.
   */
  async rotate(raw: string): Promise<IssuedToken> {
    const hash = hashToken(raw)
    const client = await this.pool.connect()

    try {
      await client.query('begin')

      // Query<T> already types rows as T[]; naming T[] here would make it T[][].
      const { rows } = await client.query<TokenRow>(
        `select id, user_id, family_id, revoked_at, expires_at
           from refresh_tokens
           where token_hash = $1
           for update`,
        [hash],
      )

      const row = rows[0]

      if (row === undefined) {
        // Deliberately not distinguished from "expired": whether a value exists
        // at all is not information to hand out to whoever presented it.
        throw new InvalidTokenError()
      }

      if (row.revoked_at !== null) {
        await client.query(`update refresh_tokens set revoked_at = now() where family_id = $1`, [
          row.family_id,
        ])
        await client.query('commit')

        throw new TokenReuseError(row.family_id)
      }

      if (row.expires_at.getTime() < Date.now()) {
        throw new InvalidTokenError()
      }

      await client.query('update refresh_tokens set revoked_at = now() where id = $1', [row.id])

      const replacement = await this.insertChild(client, row.user_id, row.family_id)

      await client.query('commit')
      return replacement
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  /** Spend one token, e.g. on logout. */
  async revoke(raw: string): Promise<void> {
    await this.pool.query(`update refresh_tokens set revoked_at = now() where token_hash = $1`, [
      hashToken(raw),
    ])
  }

  /** Spend every live token of a family. */
  async revokeFamily(familyId: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `update refresh_tokens set revoked_at = now()
         where family_id = $1 and revoked_at is null`,
      [familyId],
    )

    return rowCount ?? 0
  }

  /** Spend a user's tokens across all families: "log out everywhere". */
  async revokeAllForUser(userId: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `update refresh_tokens set revoked_at = now()
         where user_id = $1 and revoked_at is null`,
      [userId],
    )

    return rowCount ?? 0
  }

  /** Loggable identifier that cannot be turned back into a token. */
  fingerprint(raw: string): string {
    return tokenFingerprint(hashToken(raw))
  }

  private async insertChild(
    client: import('pg').PoolClient,
    userId: string,
    familyId: string,
  ): Promise<IssuedToken> {
    const raw = generateRefreshToken()
    const expiresAt = new Date(Date.now() + this.refreshTtlDays * 24 * 60 * 60 * 1000)

    const { rows } = await client.query<{ id: string }>(
      `insert into refresh_tokens (user_id, token_hash, family_id, expires_at)
         values ($1, $2, $3, $4)
         returning id`,
      [userId, hashToken(raw), familyId, expiresAt],
    )

    return { raw, tokenId: rows[0]!.id, familyId, userId, expiresAt }
  }
}
