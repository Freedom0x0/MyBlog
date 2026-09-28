import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { InvalidTokenError, TokenReuseError, type TokenStore } from './token-store.js'

export const ACCESS_COOKIE = 'portal_access'
export const REFRESH_COOKIE = 'portal_refresh'

const STATE_PREFIX = 'oauth_state:'
export const STATE_TTL_SECONDS = 600

/** A fresh session: the two credentials, plus the jti needed to revoke the access token. */
export interface EstablishedSession {
  accessToken: string
  jti: string
  /** Seconds until the access token expires; the cookie's Max-Age. */
  accessMaxAge: number
  refreshToken: string
  refreshMaxAgeDays: number
}

export class InvalidStateError extends Error {}

/**
 * Session creation, OAuth state and cookie *values*.
 *
 * Deliberately does not touch `request` or `reply`: writing cookies is an HTTP
 * concern and this module is where the rules live. Returning values instead means
 * the lifetime and rotation logic is testable without a transport, and routes stay
 * the only place that knows a response exists — the layering rule in
 * spec/backend/architecture.md.
 */
export class SessionService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly tokens: TokenStore,
  ) {}

  /** Issues both credentials for a user the provider has vouched for. */
  async establish(userId: string): Promise<EstablishedSession> {
    const jti = randomUUID()
    const refresh = await this.tokens.issue(userId)

    return {
      accessToken: this.app.signAccessToken({ sub: userId, jti }),
      jti,
      accessMaxAge: this.app.config.ACCESS_TOKEN_TTL_SECONDS,
      refreshToken: refresh.raw,
      refreshMaxAgeDays: this.app.config.REFRESH_TOKEN_TTL_DAYS,
    }
  }

  /**
   * Rotates a session.
   *
   * Reuse is logged with its family id and then rethrown unchanged: the caller's
   * answer is a plain 401 either way, because telling a client "that token was
   * already spent" would confirm which guesses are real.
   */
  async renew(refreshRaw: string): Promise<EstablishedSession> {
    try {
      const rotated = await this.tokens.rotate(refreshRaw)

      const jti = randomUUID()

      return {
        accessToken: this.app.signAccessToken({ sub: rotated.userId, jti }),
        jti,
        accessMaxAge: this.app.config.ACCESS_TOKEN_TTL_SECONDS,
        refreshToken: rotated.raw,
        refreshMaxAgeDays: this.app.config.REFRESH_TOKEN_TTL_DAYS,
      }
    } catch (error) {
      if (error instanceof TokenReuseError) {
        this.app.log.warn({ familyId: error.familyId }, 'refresh token reuse detected')
      }

      throw error
    }
  }

  /**
   * Spends the refresh token and denies the presented access token.
   *
   * The denylist step is what makes logout real: clearing cookies only stops *this*
   * browser, while a copied bearer token would otherwise keep working until its
   * lifetime ran out.
   */
  async end(
    refreshRaw: string | undefined,
    access: { jti: string; exp: number } | undefined,
  ): Promise<void> {
    if (refreshRaw !== undefined) {
      await this.tokens.revoke(refreshRaw)
    }

    if (access !== undefined) {
      const remaining = Math.max(1, access.exp - Math.floor(Date.now() / 1000))
      await this.app.denylist.revoke(access.jti, remaining)
    }
  }

  /** Stores a one-time state record and returns where to send the browser. */
  async beginLogin(returnTo: string | undefined): Promise<string> {
    const state = randomUUID()
    const { API_PUBLIC_URL, OAUTH_REDIRECT_PATH } = this.app.config

    await this.app.redis.set(
      `${STATE_PREFIX}${state}`,
      JSON.stringify({ returnTo: safeReturnTo(returnTo) }),
      { NX: true, EX: STATE_TTL_SECONDS },
    )

    return this.app.oauthProvider.authorizeUrl(state, `${API_PUBLIC_URL}${OAUTH_REDIRECT_PATH}`)
  }

  /**
   * Consumes a state value exactly once.
   *
   * GETDEL is atomic, so two concurrent callbacks carrying the same state cannot
   * both redeem it. A read-then-delete pair would leave that window open.
   */
  async consumeState(state: string): Promise<{ returnTo: string }> {
    const raw = await this.app.redis.getDel(`${STATE_PREFIX}${state}`)

    if (raw === null) {
      throw new InvalidStateError('state is unknown, expired, or already used')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new InvalidStateError('state record was unreadable')
    }

    const returnTo = (parsed as { returnTo?: unknown })?.returnTo

    return { returnTo: safeReturnTo(typeof returnTo === 'string' ? returnTo : undefined) }
  }

  /** Clears a session's tokens without an UnknownToken-vs-expired distinction. */
  assertUsableRefresh(value: string | undefined): string {
    if (value === undefined || value.length === 0) {
      throw new InvalidTokenError()
    }

    return value
  }
}

/**
 * Only same-site relative paths.
 *
 * `/^\/(?!\/)/` plus the backslash and `://` rejections matter because a naive
 * `startsWith('/')` accepts `//evil.example`, which a browser resolves as a
 * protocol-relative URL on another host — turning the login redirect into a
 * phishing link served from this domain.
 */
export function safeReturnTo(raw: string | undefined, fallback = '/'): string {
  if (typeof raw !== 'string' || raw.length === 0) return fallback
  if (!raw.startsWith('/')) return fallback
  if (raw.startsWith('//') || raw.startsWith('/\\')) return fallback
  if (raw.includes('\\') || raw.includes('://')) return fallback

  /**
   * Reject whitespace and control characters outright.
   *
   * Browsers strip them before resolving a URL, so "/<TAB>//evil.example" passes
   * every check above — it begins with a single "/" — and then resolves as
   * "//evil.example", a protocol-relative URL on another host. A guard that
   * inspects the string as written, rather than as the browser will resolve it,
   * misses exactly this.
   *
   * Written as code points rather than a control-character regex to stay legible.
   */
  for (const character of raw) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x20 || code === 0x7f) return fallback
  }

  return raw
}
