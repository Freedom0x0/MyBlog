import { randomUUID } from 'node:crypto'
import { ERROR_CODES } from 'shared'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { ApiError } from '../../errors.js'
import { requireAuth, requireCsrfHeader } from '../../plugins/auth.js'
import { AuthRepository } from './repository.js'
import { TokenStore } from './token-store.js'
import {
  ACCESS_COOKIE,
  OAUTH_NONCE_COOKIE,
  REFRESH_COOKIE,
  SessionService,
  STATE_TTL_SECONDS,
  safeReturnTo,
} from './session.js'
import { MeSchema } from './schema.js'
import { InvalidTokenError, TokenReuseError } from './token-store.js'

const StartQuerySchema = z.object({
  return_to: z.string().max(500).optional(),
})

const CallbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
})

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const tokens = new TokenStore(app.db, app.config.REFRESH_TOKEN_TTL_DAYS)
  const users = new AuthRepository(app.db)
  const sessions = new SessionService(app, tokens)

  const redirectUri = `${app.config.API_PUBLIC_URL}${app.config.OAUTH_REDIRECT_PATH}`

  /**
   * Applies a session to the response.
   *
   * `Secure` is switched off only where the config says so, which is local http
   * development: without the flag browsers refuse to store the cookie at all over
   * http, and with it the cookie is dropped on every non-TLS hop. The config makes
   * that a deliberate, visible choice rather than a silent default.
   */
  function attach(res: import('fastify').FastifyReply, session: Awaited<ReturnType<typeof sessions.establish>>) {
    const secure = app.config.COOKIE_SECURE

    res.setCookie(ACCESS_COOKIE, session.accessToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: session.accessMaxAge,
    })

    res.setCookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true,
      secure,
      // Narrow path: the refresh token travels only to the auth endpoints, so no
      // other request — present or future — can carry it into a log or an upstream.
      sameSite: 'strict',
      path: '/api/v1/auth',
      maxAge: session.refreshMaxAgeDays * 24 * 60 * 60,
    })
  }

  function clear(res: import('fastify').FastifyReply) {
    const secure = app.config.COOKIE_SECURE
    res.clearCookie(ACCESS_COOKIE, { path: '/', secure, httpOnly: true, sameSite: 'lax' })
    res.clearCookie(REFRESH_COOKIE, {
      path: '/api/v1/auth',
      secure,
      httpOnly: true,
      sameSite: 'strict',
    })
  }

  // ── login ──────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/auth/github/start',
    { schema: { querystring: StartQuerySchema } },
    async (request, reply) => {
      /**
       * The nonce is a second secret handed only to this browser. state proves the
       * attempt is known; the nonce proves *who* started it — without it, a
       * third party could hand a victim their own callback URL and have the victim
       * end up signed in as the attacker.
       */
      const nonce = randomUUID()

      reply.setCookie(OAUTH_NONCE_COOKIE, nonce, {
        httpOnly: true,
        secure: app.config.COOKIE_SECURE,
        sameSite: 'lax',
        path: '/api/v1/auth',
        maxAge: STATE_TTL_SECONDS,
      })

      return reply.redirect(await sessions.beginLogin(request.query.return_to, nonce), 302)
    },
  )

  app.get(
    '/api/v1/auth/github/callback',
    {
      schema: { querystring: CallbackQuerySchema },
    },
    async (request, reply) => {
      const query = request.query

      /**
       * Checked before state: if the user clicked "cancel" on GitHub's consent
       * screen there is no code to redeem and no state to consume, and reporting
       * a state problem would send them round in circles.
       */
      if (query.error !== undefined) {
        request.log.info({ reason: query.error }, 'provider reported an authorization error')
        throw new ApiError(ERROR_CODES.oauthDenied, 'Authorization was denied at the provider', 400)
      }

      if (query.code === undefined || query.state === undefined) {
        throw new ApiError(ERROR_CODES.invalidState, 'Callback is missing code or state', 400)
      }

      let returnTo: string
      try {
        returnTo = (await sessions.consumeState(query.state, request.cookies?.[OAUTH_NONCE_COOKIE]))
          .returnTo
      } catch (error) {
        request.log.info({ err: error }, 'oauth state rejected')
        throw new ApiError(ERROR_CODES.invalidState, 'Login session expired or was already used', 400)
      }

      let providerToken: string
      let profile: Awaited<ReturnType<typeof app.oauthProvider.fetchProfile>>

      try {
        providerToken = await app.oauthProvider.exchangeCode(query.code, redirectUri)
        profile = await app.oauthProvider.fetchProfile(providerToken)
      } catch (error) {
        const isExchange = error instanceof Error && error.constructor.name === 'OAuthExchangeError'
        request.log.warn({ err: error }, 'provider step failed')
        throw new ApiError(
          isExchange ? ERROR_CODES.oauthExchangeFailed : ERROR_CODES.oauthProfileFailed,
          'The identity provider did not complete the request',
          502,
        )
      }

      /**
       * Upsert keyed on login, with is_admin written only on INSERT.
       *
       * On conflict the flag is deliberately absent from the update list. Including
       * it — or reusing the same object for both branches — would reset a granted
       * admin back to false on their next sign-in, and the inverse mistake (an
       * `is_admin: true` in the values path) would hand out the role.
       */
      // Keyed on GitHub's immutable id, never the mutable login: see
      // AuthRepository.upsertFromProfile for the squatting scenario this prevents.
      const userId = await users.upsertFromProfile(profile)
      // The nonce has done its job; keeping it alive would only widen the window in
      // which a stolen state value could be paired with it.
      reply.clearCookie(OAUTH_NONCE_COOKIE, {
        path: '/api/v1/auth',
        secure: app.config.COOKIE_SECURE,
        httpOnly: true,
        sameSite: 'lax',
      })
      const session = await sessions.establish(userId)

      attach(reply, session)
      request.log.info({ userId, login: profile.login }, 'login succeeded')

      // An ABSOLUTE target, on purpose. `Location: /blog/x` is resolved by the
      // browser against the URL that answered the redirect — this API, port 3001 —
      // not against the site the person came from, so a successful sign-in ended on
      // the API's 404 page. Every existing test compared the header verbatim and
      // saw `/blog/x`, which is why it took a real browser to find. `safeReturnTo`
      // still does its job: only a rooted path can reach here, and it is hung off
      // the one origin the config allows.
      return reply.redirect(`${app.config.PORTAL_WEB_ORIGIN}${safeReturnTo(returnTo)}`, 302)
    },
  )

  // ── session lifecycle ──────────────────────────────────────────────────────
  app.post(
    '/api/v1/auth/refresh',
    { onRequest: [requireCsrfHeader] },
    async (request, reply) => {
      const raw = request.cookies?.[REFRESH_COOKIE]

      try {
        const session = await sessions.renew(sessions.assertUsableRefresh(raw))
        attach(reply, session)
        return { ok: true }
      } catch (error) {
        if (error instanceof InvalidTokenError || error instanceof TokenReuseError) {
          // Clear on the way out: a stale cookie that keeps being sent turns one
          // dead session into a request that fails on every navigation.
          clear(reply)
          throw new ApiError(ERROR_CODES.unauthorized, 'Session expired', 401)
        }
        throw error
      }
    },
  )

  app.post(
    '/api/v1/auth/logout',
    { onRequest: [requireCsrfHeader] },
    async (request, reply) => {
      /**
       * Best-effort verification rather than the `requireAuth` preHandler.
       *
       * Logging out with an already-dead token should still succeed — failing here
       * would strand someone in a half-logged-out state they cannot escape. But it
       * must still revoke the bearer credential if it is live: without this step,
       * `requireAuth` never populates `request.auth`, logout only clears cookies,
       * and a copied token keeps working until it expires on its own.
       */
      let access: { jti: string; exp: number } | undefined

      try {
        const token = request.headers.authorization?.startsWith('Bearer ')
          ? request.headers.authorization.slice(7).trim()
          : request.cookies?.[ACCESS_COOKIE]

        if (token !== undefined) {
          const verified = app.verifyAccessToken(token)
          access = { jti: verified.jti, exp: verified.exp }
        }
      } catch (error) {
        request.log.debug({ err: error }, 'logout without a live access token')
      }

      await sessions.end(request.cookies?.[REFRESH_COOKIE], access)
      clear(reply)

      return reply.code(204).send()
    },
  )

  app.get(
    '/api/v1/auth/me',
    {
      onRequest: [requireAuth],
      schema: { response: { 200: MeSchema } },
    },
    async (request): Promise<{ user: import('shared').SessionUser }> => {
      const user = await users.findSessionUser(request.auth!.sub)

      if (user === null) {
        throw new ApiError(ERROR_CODES.unauthorized, 'Account no longer exists', 401)
      }

      return { user }
    },
  )
}
