/**
 * Shared contracts between the portal API (`apps/api`) and the portal web app (`apps/web`).
 *
 * Internal package: consumed as TypeScript source, no build step. Both consumers
 * are TS-aware (Vite for web, tsx/tsc for api), so publishing raw source keeps
 * the contract in one place with no compilation step to keep in sync.
 */

/**
 * The single error envelope every API error response uses.
 *
 * `code` is for programs, `message` is for humans, `requestId` is for finding the
 * log line — the three are deliberately not merged into one string.
 */
export interface ApiErrorEnvelope {
  error: {
    code: string
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
