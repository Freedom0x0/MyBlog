import fp from 'fastify-plugin'
import jwt from '@fastify/jwt'
import { ERROR_CODES } from 'shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Config } from '../config/index.js'
import { ApiError } from '../errors.js'

/** The verified subset of an access token. */
export interface AuthContext {
  sub: string
  jti: string
  exp: number
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * The only place allowed to mint an access token.
     *
     * `@fastify/jwt` does not reject a token lacking `exp`, even when `maxAge` is
     * supplied at verification (proved by a characterisation test in
     * lib/tokens.test.ts). So the lifetime exists only because this function
     * always attaches it. Exposed as one call rather than letting every route
     * reach for `app.jwt.sign` is what turns that from a convention into a
     * constraint.
     */
    signAccessToken(claims: { sub: string; jti: string }): string
    /** Verify signature, shape and expiry; throws a 401-mapped ApiError. */
    verifyAccessToken(token: string): AuthContext
  }

  interface FastifyRequest {
    /** Populated by `requireAuth`; undefined otherwise. */
    auth?: AuthContext
  }
}

interface RawClaims {
  sub?: unknown
  jti?: unknown
  exp?: unknown
}

export const authPlugin = fp(
  async (app: FastifyInstance, options: { config: Config }): Promise<void> => {
    const { config } = options

    await app.register(jwt, {
      secret: config.JWT_SECRET,
      cookie: { cookieName: 'portal_access', signed: false },
    })

    app.decorate('signAccessToken', (claims: { sub: string; jti: string }): string =>
      app.jwt.sign(claims, { expiresIn: config.ACCESS_TOKEN_TTL_SECONDS }),
    )

    /**
     * Verify, then apply the checks the library does not.
     *
     * Order matters for information disclosure: signature failure, revocation and
     * shape problems all surface as the same 401 with the same code, because none
     * of them is the caller's business. The distinction is logged, not returned.
     */
    app.decorate('verifyAccessToken', (token: string): AuthContext => {
      let claims: RawClaims
      try {
        claims = app.jwt.verify<RawClaims>(token)
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'unknown'
        app.log.debug({ code }, 'access token rejected')
        throw new ApiError(ERROR_CODES.unauthorized, 'Invalid or missing credentials', 401)
      }

      const { sub, jti, exp } = claims

      if (typeof sub !== 'string' || typeof jti !== 'string' || typeof exp !== 'number') {
        // Reached only by a token minted outside signAccessToken.
        app.log.error({ sub, jti }, 'access token missing sub/jti/exp — signing leak')
        throw new ApiError(ERROR_CODES.unauthorized, 'Invalid credentials', 401)
      }

      return { sub, jti, exp }
    })
  },
)

/**
 * Reject a token the denylist has already buried, even though its signature is
 * perfect. This is the whole reason the denylist exists.
 */
export async function assertNotRevoked(app: FastifyInstance, auth: AuthContext): Promise<void> {
  if (await app.denylist.isRevoked(auth.jti)) {
    throw new ApiError(ERROR_CODES.unauthorized, 'Session ended', 401)
  }
}

/** PreHandler: requires a live access token. */
export async function requireAuth(request: FastifyRequest): Promise<void> {
  const app = request.server
  const token = extractToken(request)

  if (token === undefined) {
    throw new ApiError(ERROR_CODES.unauthorized, 'Authentication required', 401)
  }

  const auth = app.verifyAccessToken(token)
  await assertNotRevoked(app, auth)
  request.auth = auth
}

/**
 * Requires a custom header that a cross-site form cannot set.
 *
 * Third layer, not a replacement: HttpOnly stops a script reading the token,
 * SameSite stops most cross-site requests carrying the cookie at all, but a
 * top-level cross-site *navigation* still sends a Lax cookie — so state-changing
 * endpoints need something the browser will not forge on another site's behalf.
 */
export async function requireCsrfHeader(request: FastifyRequest): Promise<void> {
  if (request.headers['x-requested-with'] !== 'portal') {
    throw new ApiError(ERROR_CODES.csrfCheckFailed, 'Missing required header', 403)
  }
}

function extractToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim()
  }
  return request.cookies?.portal_access
}
