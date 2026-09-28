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
async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  options: { signal?: AbortSignal; csrf?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }

  if (options.csrf === true) {
    /**
     * The API requires this header on state-changing calls. It is not a secret —
     * it is proof the request came from our own script, because a cross-site form
     * cannot set custom headers and the browser will not let another origin add
     * one to a fetch either.
     */
    headers['x-requested-with'] = 'portal'
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    signal: options.signal,
    // Without this the browser withholds cookies on a cross-origin request, and
    // CORS allow-credentials on the server side would be pointless.
    credentials: 'include',
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

export function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>('GET', path, { signal })
}

/** POST with the CSRF header the API requires on state-changing calls. */
export function apiPost<T>(path: string): Promise<T> {
  return request<T>('POST', path, { csrf: true })
}
