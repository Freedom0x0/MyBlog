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

/** Every method this client speaks. Anything else is a bug in a caller. */
type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

interface RequestOptions {
  signal?: AbortSignal
  /**
   * JSON-serialised body, sent only for the write methods that take one.
   *
   * It lives on the options object rather than as a fourth positional parameter
   * because most calls (`GET`, `DELETE`) never have one, and a required-but-
   * sometimes-`undefined` argument reads like a hole in the signature.
   */
  body?: unknown
}

/**
 * Fetch and parse, throwing one error type for every failure.
 *
 * `!res.ok` alone would not be enough: the body is the part that says *why*, and
 * the envelope's `code` is what callers branch on. A non-JSON error body (proxy,
 * gateway) still becomes an ApiError rather than a `SyntaxError` from `.json()`.
 *
 * The CSRF header is derived from the *method*, not from an option: design §5
 * names "CSRF on POST only" as the trap, and a per-call flag is exactly how that
 * trap survives — a new `apiPatch` would have to remember to set it. Stating it
 * as "not a read" makes forgetting impossible. A 201/204 write that needs no
 * body still gets the header.
 */
async function request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }

  if (method !== 'GET') {
    /**
     * The API requires this header on state-changing calls. It is not a secret —
     * it is proof the request came from our own script, because a cross-site form
     * cannot set custom headers and the browser will not let another origin add
     * one to a fetch either.
     */
    headers['x-requested-with'] = 'portal'
  }

  const hasBody = options.body !== undefined

  if (hasBody) {
    // Not a preference: Fastify's schema validation rejects a JSON body without
    // the media type, so the writes that carry data have to announce it.
    headers['content-type'] = 'application/json'
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    signal: options.signal,
    // Without this the browser withholds cookies on a cross-origin request, and
    // CORS allow-credentials on the server side would be pointless.
    credentials: 'include',
    body: hasBody ? JSON.stringify(options.body) : undefined,
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

  /**
   * No-content responses have no body to parse, and `response.json()` on one
   * rejects with a `SyntaxError` — which is not an `ApiError`, so a caller's
   * `catch (ApiError)` would miss it and the user would see a crash where the
   * server said "done". `DELETE /api/v1/articles/:slug` and `.../comments/:id`
   * both answer 204.
   *
   * Checked by status rather than by sniffing `content-length`, because 204 is
   * what the API's contract says and a header is what a proxy might change.
   */
  if (response.status === 204 || response.status === 205) {
    return undefined as T
  }

  return (await response.json()) as T
}

export function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>('GET', path, { signal })
}

/**
 * `POST` with a JSON body. `payload` is optional because `/auth/logout` is a
 * state-changing call that carries nothing but still needs the CSRF header.
 */
export function apiPost<T>(path: string, payload?: unknown): Promise<T> {
  return request<T>('POST', path, { body: payload })
}

export function apiPatch<T>(path: string, payload: unknown): Promise<T> {
  return request<T>('PATCH', path, { body: payload })
}

/** `DELETE` answers 204 with no body, hence `void` rather than a response type. */
export function apiDelete(path: string): Promise<void> {
  return request<void>('DELETE', path)
}

/**
 * The text to show a person when a call failed.
 *
 * Lives next to `ApiError` rather than in each screen because "failure is
 * visible" is one rule, and screens that each reinvent it drift — the article
 * editor used to turn a failed write into a silent local save, which is the same
 * mistake seen from the other side.
 *
 * `ApiError.message` is the envelope's `message`, written server-side for humans
 * ("slug is already taken: …", "excerpt: String must contain at most 500
 * character(s)"), so it is forwarded verbatim instead of being mapped to a
 * screen-local string that would go stale the moment the backend's vocabulary
 * changes. A non-API failure (the fetch itself rejecting when the API is down)
 * keeps its own message; `fallback` covers the shapeless `unknown` case.
 */
export function describeApiError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  return fallback
}
