/**
 * Shared contracts between the portal API (`apps/api`) and the portal web app
 * (`apps/web`).
 *
 * Internal package. It emits its own `dist` rather than exposing `src`, because
 * `apps/api` sets `rootDir: src` and imports a *runtime* value from here — with a
 * source-only package the emitted file graph escapes that rootDir. See the S1
 * SPIKE-2 conclusion in the task notes.
 */

/**
 * The public error vocabulary.
 *
 * These are ours, deliberately. Framework and driver codes (`FST_ERR_VALIDATION`
 * from Fastify, `23505` from Postgres) must never reach a client: clients branch
 * on `code`, so it has to be stable across dependency upgrades, and a SQLSTATE
 * describes the schema.
 */
export const ERROR_CODES = {
  badRequest: 'BAD_REQUEST',
  unauthorized: 'UNAUTHORIZED',
  forbidden: 'FORBIDDEN',
  notFound: 'NOT_FOUND',
  conflict: 'CONFLICT',
  payloadTooLarge: 'PAYLOAD_TOO_LARGE',
  unsupportedMediaType: 'UNSUPPORTED_MEDIA_TYPE',
  rateLimited: 'RATE_LIMITED',
  internalError: 'INTERNAL_ERROR',

  /** Domain codes, stable additions for the article and comment modules. */
  articleNotFound: 'ARTICLE_NOT_FOUND',
  invalidCursor: 'INVALID_CURSOR',
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/**
 * The single error envelope every API error response uses.
 *
 * `code` is for programs to branch on, `message` is for humans, `requestId` is
 * for finding the log line that explains what actually happened. The three are
 * deliberately not merged into one string.
 */
export interface ApiErrorEnvelope {
  error: {
    code: ErrorCode
    message: string
    requestId: string
  }
}

/** Readiness payload returned by `GET /ready`. */
export interface ReadinessPayload {
  status: 'ok' | 'degraded'
  checks: Record<string, 'ok' | 'failed'>
}

/** Liveness payload returned by `GET /health`. */
export interface LivenessPayload {
  status: 'ok'
}
