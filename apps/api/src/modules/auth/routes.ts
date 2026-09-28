import { ERROR_CODES } from 'shared'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { ApiError } from '../../errors.js'
import { requireAuth, requireCsrfHeader } from '../../plugins/auth.js'
import { TokenStore } from './token-store.js'
import { ACCESS_COOKIE, REFRESH_COOKIE, SessionService, safeReturnTo } from './session.js'
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

interface UserRow {
  id: string
  github_login: string
  display_name: string | null
  avatar_url: string | null
  is_admin: boolean
}

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const tokens = new TokenStore(app.db, app.config.REFRESH_TOKEN_TTL_DAYS)
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
    async (_request, reply) => reply.redirect(await sessions.beginLogin(_request.query.return_to), 302),
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
        returnTo = (await sessions.consumeState(query.state)).returnTo
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
      const { rows } = await app.db.query<{ id: string }>(
        `insert into users (github_login, display_name, avatar_url, is_admin)
           values ($1, $2, $3, false)
         on conflict (github_login) do update
           set display_name = excluded.display_name,
               avatar_url   = excluded.avatar_url
         returning id`,
        [profile.login, profile.displayName, profile.avatarUrl],
      )

      const userId = rows[0]!.id
      const session = await sessions.establish(userId)

      attach(reply, session)
      request.log.info({ userId, login: profile.login }, 'login succeeded')

      return reply.redirect(safeReturnTo(returnTo), 302)
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
      const { rows } = await app.db.query<UserRow>(
        `select id, github_login, display_name, avatar_url, is_admin
           from users where id = $1`,
        [request.auth!.sub],
      )

      const row = rows[0]

      if (row === undefined) {
        throw new ApiError(ERROR_CODES.unauthorized, 'Account no longer exists', 401)
      }

      return {
        user: {
          id: row.id,
          login: row.github_login,
          displayName: row.display_name,
          avatarUrl: row.avatar_url,
          isAdmin: row.is_admin,
        },
      }
    },
  )
}
