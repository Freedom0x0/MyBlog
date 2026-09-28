/**
 * Minimal client for the portal API.
 *
 * Written by hand rather than pulling in a generated client or axios: there is
 * one base URL, JSON in and out, and the error envelope is already a contract in
 * `packages/shared`. Anything more would be a dependency for no behaviour.
 */
import type { ApiErrorEnvelope } from 'shared'

const BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3001/api/v1'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
    message?: string,
  ) {
    super(message ?? `API request failed (${status})`)
    this.name = 'ApiError'
  }
}

function isEnvelope(value: unknown): value is ApiErrorEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ApiErrorEnvelope).error?.code === 'string'
  )
}

/**
 * Fetch and parse, throwing one error type for every failure.
 *
 * `!res.ok` alone would not be enough: the body is the part that says *why*, and
 * the envelope's `code` is what callers branch on. A non-JSON error body (proxy,
 * gateway) still becomes an ApiError rather than a `SyntaxError` from `.json()`.
 */
export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal,
  })

  if (!response.ok) {
    const raw = await response.text()
    let code = 'REQUEST_FAILED'
    let message: string | undefined
    let requestId: string | undefined

    try {
      const parsed: unknown = JSON.parse(raw)
      if (isEnvelope(parsed)) {
        code = parsed.error.code
        message = parsed.error.message
        requestId = parsed.error.requestId
      }
    } catch {
      // Non-JSON error body: keep the generic code and let `raw` inform message.
      message = raw.slice(0, 200)
    }

    throw new ApiError(response.status, code, requestId, message)
  }

  return (await response.json()) as T
}
