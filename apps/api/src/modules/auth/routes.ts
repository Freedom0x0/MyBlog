import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { SessionUser } from 'shared'
import { ERROR_CODES } from 'shared'
import { ApiError } from '../../errors.js'
import { requireAuth, type AuthContext } from '../../plugins/auth.js'
import { MeSchema } from './schema.js'

interface UserRow {
  id: string
  github_login: string
  display_name: string | null
  avatar_url: string | null
  is_admin: boolean
}

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  /**
   * The client's only source of truth about who is signed in.
   *
   * `isAdmin` is read from the database here, so the front end never has to
   * decide by comparing a username against a constant in its own bundle — which
   * is exactly how the UI half of defect D1 worked, and why it was only ever a
   * cosmetic control: the real gate was RLS reading a self-writable claim.
   */
  app.get(
    '/api/v1/auth/me',
    {
      onRequest: [requireAuth],
      schema: { response: { 200: MeSchema } },
    },
    async (request): Promise<{ user: SessionUser }> => {
      const auth = request.auth as AuthContext
      const { rows } = await app.db.query<UserRow>(
        `select id, github_login, display_name, avatar_url, is_admin
           from users where id = $1`,
        [auth.sub],
      )

      const row = rows[0]

      if (row === undefined) {
        // Valid signature, no account: the token outlived the user.
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
