import fp from 'fastify-plugin'
import type { FastifyError, FastifyInstance } from 'fastify'
import type { ApiErrorEnvelope } from 'shared'
import { ApiError } from '../errors.js'

/**
 * Public code vocabulary for errors we did not raise ourselves.
 *
 * Framework and driver codes must never reach the client: `FST_ERR_*` is
 * Fastify's internal naming and changes across majors, and a Postgres SQLSTATE
 * (`23505` = unique violation) describes the schema. Clients branch on these
 * codes, so they have to be ours and they have to be stable.
 */
const CODE_BY_STATUS: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
}

/**
 * One error shape for the whole API.
 *
 *   { error: { code, message, requestId } }
 *
 * The three fields are deliberately separate: `code` is for programs to branch
 * on, `message` is for humans, `requestId` is for finding the log line that
 * explains what actually happened. Merging them into one string is what makes
 * error handling degrade into string matching.
 *
 * Routes must not build error responses by hand — they throw (an `ApiError` when
 * the code matters), and this handler formats. That keeps the contract in
 * exactly one place.
 */
export const errorHandlerPlugin = fp(async (app: FastifyInstance): Promise<void> => {
  // Fastify's default 404 body does not match the envelope, so it is replaced.
  app.setNotFoundHandler((request, reply) => {
    const body: ApiErrorEnvelope = {
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
        requestId: request.id,
      },
    }
    reply.code(404).send(body)
  })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500

    /**
     * 5xx means we broke, so the full error — stack included — goes to the log.
     * The client gets a generic message: internal details (SQL, file paths,
     * library internals) are an information leak and are not actionable for the
     * caller anyway.
     *
     * 4xx means the caller broke, so their own message is safe and useful.
     */
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed')
    }

    // Both fields are derived with the same rule. Scrubbing the message but
    // forwarding the code would still hand out `23505` or `FST_ERR_*`.
    const isDeliberate = error instanceof ApiError

    const code = isDeliberate
      ? error.code
      : (CODE_BY_STATUS[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'))

    const body: ApiErrorEnvelope = {
      error: {
        code,
        message: status >= 500 ? 'Internal server error' : error.message,
        requestId: request.id,
      },
    }

    reply.code(status).send(body)
  })
})
