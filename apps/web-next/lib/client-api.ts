import type {
  ApiErrorEnvelope,
  CommentList,
  CommentNode,
  CreateCommentInput,
  SessionUser,
} from 'shared'

/**
 * The browser-side transport, mirroring `apps/web/src/lib/apiClient.ts`.
 *
 * Kept separate from {@link './api'} on purpose: that module runs in the server and
 * talks to `API_INTERNAL_URL`, this one runs in the visitor's browser and talks to
 * **same-origin `/api/v1`**, which `next.config.ts` rewrites onto the API. Same-origin
 * is not cosmetic — `apps/api` allows credentials for exactly one CORS origin
 * (`PORTAL_WEB_ORIGIN`, the SPA's `http://localhost:5175`), so a direct call to
 * `http://127.0.0.1:3001` from port 3000 would be refused, and "fixing" that in the
 * API would widen a server-side auth surface for the sake of a dev port.
 *
 * Only comments and the session go through here. Articles are server-rendered, and
 * the session is per-visitor, which is why neither is cached by Next (design D-5).
 */
const BASE_URL = '/api/v1'

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

type HttpMethod = 'GET' | 'POST' | 'DELETE'

interface RequestOptions {
  body?: unknown
}

/**
 * Fetch and parse, throwing one error type for every failure.
 *
 * The CSRF header is derived from the *method*, not from a per-call option: the API
 * requires it on state-changing calls, and a flag a caller has to remember is how that
 * rule gets broken the first time somebody adds a `POST`. See `apiClient.ts` in the
 * SPA for the same reasoning at the same place.
 */
async function request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }

  if (method !== 'GET') headers['x-requested-with'] = 'portal'

  const hasBody = options.body !== undefined
  if (hasBody) headers['content-type'] = 'application/json'

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
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
      // A non-JSON error body (proxy, gateway) still becomes an ApiError rather
      // than the SyntaxError `.json()` would have thrown.
      message = raw.slice(0, 200)
    }

    throw new ApiError(response.status, code, requestId, message)
  }

  // 204 has no body, and `.json()` on it rejects — which is not an ApiError, so a
  // caller's `catch (ApiError)` would miss it and crash where the server said "done".
  if (response.status === 204 || response.status === 205) return undefined as T

  return (await response.json()) as T
}

/**
 * `GET /auth/me` → the visitor, or `null`.
 *
 * 401 is the ordinary "not signed in" answer and is turned into `null` rather than
 * shown as a fault; anything else propagates so a broken API does not read as
 * "everyone is logged out".
 */
export async function fetchMe(): Promise<SessionUser | null> {
  try {
    const { user } = await request<{ user: SessionUser }>('GET', '/auth/me')
    return user
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null
    throw error
  }
}

/**
 * `POST /auth/logout` → 204 with no body.
 *
 * A session that is already ended server-side is a success from the visitor's point
 * of view, so 401 is swallowed; anything else propagates, because "退出失败" said out
 * loud beats a header that quietly still shows the avatar.
 */
export async function signOut(): Promise<void> {
  try {
    await request<void>('POST', '/auth/logout')
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return
    throw error
  }
}

/**
 * The sign-in URL: a whole-page navigation to the API's OAuth start, not a fetch.
 *
 * `return_to` is the path inside *this* app; the API redirects back to
 * `PORTAL_WEB_ORIGIN` after the callback, which in production is the single public
 * origin behind nginx and in dev is still the SPA's port — see README ("sign-in").
 */
export function loginUrl(returnTo: string): string {
  return `${BASE_URL}/auth/github/start?return_to=${encodeURIComponent(returnTo)}`
}

/** `GET /articles/:slug/comments` — the flat, `parentId`-linked list (design D-5: client-side). */
export async function listComments(slug: string): Promise<CommentNode[]> {
  const list = await request<CommentList>('GET', `/articles/${encodeURIComponent(slug)}/comments`)
  return list.data
}

/**
 * `POST /articles/:slug/comments` → 201 with the server's full node.
 *
 * No author is sent: the API derives the commenter from the verified session, so the
 * write and the read agree on who owns a comment.
 */
export async function postComment(slug: string, input: CreateCommentInput): Promise<CommentNode> {
  return request<CommentNode>('POST', `/articles/${encodeURIComponent(slug)}/comments`, {
    body: input,
  })
}

/** `DELETE /comments/:id` → 204. Author or admin, enforced server-side. */
export async function deleteComment(id: string): Promise<void> {
  return request<void>('DELETE', `/comments/${encodeURIComponent(id)}`)
}

/**
 * The text to show a person when a call failed.
 *
 * The envelope's server-written message is forwarded verbatim instead of being
 * mapped to a screen-local string that goes stale the moment the backend's
 * vocabulary changes.
 */
export function describeApiError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  return fallback
}
