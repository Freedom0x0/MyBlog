import { ERROR_CODES } from 'shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ApiError } from '../../errors.js'
import { requireAuth } from '../../plugins/auth.js'

/**
 * Requires an authenticated admin.
 *
 * The check reads `users.is_admin` from the database on every call. It does not
 * consult a JWT claim, and that is the fix for defect D1: the old RLS function
 * asked whether the caller's *self-writable* metadata said they were the admin,
 * so anyone could grant themselves the role. Anything a user can change is a
 * preference, not a permission.
 *
 * The extra read is affordable because guarded routes are administrative and rare;
 * putting the flag in the token would have made revocation impossible until the
 * 15-minute expiry passed.
 */
export async function requireAdmin(request: FastifyRequest): Promise<void> {
  await requireAuth(request)

  const app = request.server as FastifyInstance
  const auth = request.auth

  if (auth === undefined) {
    throw new ApiError(ERROR_CODES.unauthorized, 'Authentication required', 401)
  }

  const { rows } = await app.db.query<{ is_admin: boolean }>(
    'select is_admin from users where id = $1',
    [auth.sub],
  )

  const user = rows[0]

  // No row means the account is gone while its token is still valid. That is a
  // 401 (your identity no longer exists), not a 403 (you exist but lack rights).
  if (user === undefined) {
    throw new ApiError(ERROR_CODES.unauthorized, 'Account no longer exists', 401)
  }

  if (user.is_admin !== true) {
    request.log.warn({ userId: auth.sub }, 'admin route denied')
    throw new ApiError(ERROR_CODES.forbidden, 'Administrator access required', 403)
  }
}
