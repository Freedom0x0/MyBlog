import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'

declare module 'fastify' {
  interface FastifyInstance {
    denylist: Denylist
  }
}

export interface Denylist {
  /** Mark a token id dead until its own expiry. */
  revoke(jti: string, ttlSeconds: number): Promise<void>
  isRevoked(jti: string): Promise<boolean>
}

const PREFIX = 'deny:'

/**
 * A short-TTL denylist for access tokens.
 *
 * Why it exists: an access token is verified by signature alone, so a logout
 * cannot take it away — it outlives the session for up to its full lifetime. The
 * denylist closes that window by remembering the id until the token would have
 * expired anyway, after which the entry is pointless and Redis forgets it.
 *
 * Why Redis and not process memory: the API runs as several instances behind a
 * load balancer (R9). A per-process Set would make logout succeed only on the
 * instance that handled the logout, so the same token keeps working on the others
 * — which is a worse version of "logging out does nothing".
 *
 * The honest cost: this is one Redis round trip per authenticated request, bought
 * in exchange for not waiting out the TTL. Shortening the lifetime trades it back.
 */
export const denylistPlugin = fp(
  async (app: FastifyInstance): Promise<void> => {
    const denylist: Denylist = {
      async revoke(jti: string, ttlSeconds: number): Promise<void> {
        // EX rather than a plain set: an entry outliving its token is a leak that
        // nothing ever collects.
        await app.redis.set(`${PREFIX}${jti}`, '1', { NX: true, EX: Math.max(1, ttlSeconds) })
      },

      async isRevoked(jti: string): Promise<boolean> {
        return (await app.redis.exists(`${PREFIX}${jti}`)) === 1
      },
    }

    app.decorate('denylist', denylist)
  },
)
