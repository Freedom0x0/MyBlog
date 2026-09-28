import { createHash, randomBytes, randomUUID } from 'node:crypto'

/**
 * Token primitives.
 *
 * JWT signing and verification deliberately live with `@fastify/jwt` on the app
 * rather than being re-implemented here: HS256 is exactly the part of auth that
 * should not be hand-rolled, and a second implementation would be a second thing
 * to get subtly wrong. What is ours — and therefore here — is the refresh token's
 * shape, its storage form, and the identity fields the claims carry.
 */

/** What goes into an access token. Nothing else. */
export interface AccessTokenClaims {
  /** The user's id. */
  sub: string
  /**
   * Unique token id, so a specific token can be denied before it expires.
   *
   * Without it the only revocation lever is waiting out the lifetime.
   */
  jti: string
}

/** 256 bits of entropy, base64url: ~43 chars, no padding. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url')
}

export function generateJti(): string {
  return randomUUID()
}

/**
 * Storage form of a refresh token.
 *
 * SHA-256 rather than a password hash (argon2/bcrypt): those exist to slow down
 * attackers guessing a low-entropy secret. A 256-bit random value has nothing to
 * guess, so a fast hash is the correct tool — it makes a leaked table unusable
 * without adding per-request latency.
 */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

/**
 * A short, non-reversible prefix for log correlation.
 *
 * Logging the hash itself would let anyone with log access attempt a dictionary
 * search against it, and logging the value is the bug we are avoiding entirely.
 */
export function tokenFingerprint(hash: string): string {
  return hash.slice(0, 8)
}
