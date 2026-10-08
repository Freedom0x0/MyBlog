/**
 * Minimal client for the portal API.
 *
 * Written by hand rather than pulling in a generated client or axios: there is
 * one base URL, JSON in and out, and the error envelope is already a contract in
 * `packages/shared`. Anything more would be a dependency for no behaviour.
 *
 * This file is also the only module in `apps/web` that calls `fetch`, and the only
 * one that touches the session at all. {@link putPresignedObject} is the single
 * deliberate exception inside that rule — it calls `fetch` against the object store
 * while sending *no* session and *no* portal headers, so it sits here under its own
 * header rather than in a second transport module that a future reader would have to
 * discover and decide to trust.
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
 * PUT raw bytes to a presigned object-storage URL, and nothing else.
 *
 * **This is the one request in the app that must not go through {@link request}.**
 * `request` exists for the portal API: it adds `x-requested-with`, sends
 * `content-type: application/json` whenever there is a body, and attaches the session
 * cookie. MinIO is a different origin and knows nothing about our session, so each of
 * those three is wrong here for its own reason — all of them measured, in SPIKE-E, and
 * recorded in `.trellis/tasks/09-29-blog-portal-s3-write-path/implement.md`:
 *
 * - The signature covers `host` only (`X-Amz-SignedHeaders=host`), so a header this
 *   client chooses to send is a header the signature does not cover. Measured: the same
 *   presigned PUT with the browser's whole automatic header set is `200`, while one
 *   extra unsigned `x-amz-*` header is
 *   `400 AccessDenied — "There were headers present in the request which were not
 *   signed"`, and an `Authorization` header is
 *   `400 InvalidRequest — "request has multiple authentication types"`. `Content-Type`
 *   is therefore the only header this call sets, because it is the only one the request
 *   has a use for. The portal's CSRF signal means nothing on the other side.
 * - Whatever `Content-Type` is declared is what the object *keeps* (measured: a PUT
 *   declaring `text/plain` stored `text/plain`). `request` would announce JSON, and
 *   that label would be the object's forever — the reason the media type is a parameter
 *   here, and the reason the API re-sniffs the bytes at `complete` rather than trusting
 *   this header.
 * - `credentials: 'omit'`: the signed URL is the entire capability, so the session
 *   cookie would buy nothing and would be handed to a third-party origin for free.
 *   Note that `include` is not *blocked* — the bucket's preflight measured
 *   `Access-Control-Allow-Credentials: true` — which is exactly why the omission has to
 *   be written down rather than left to whoever edits this next.
 *
 * Two traps that fire from outside this function and read like a storage bug:
 *
 * - The page must be opened as **`http://localhost:5175`**, never
 *   `http://127.0.0.1:5175`. MinIO's CORS allowlist is an exact-string match with no
 *   `localhost`/`127.0.0.1` normalisation — measured, an `OPTIONS` from an origin not on
 *   the list answers `204` with *zero* `Access-Control-*` headers, so the browser fails
 *   the fetch with a bare `TypeError` and nothing to say why. `pnpm --filter web dev`
 *   binds `127.0.0.1` (`apps/web/package.json:7`), which is what makes this a live trap
 *   rather than a theoretical one.
 * - The URL's host must stay exactly as issued (`localhost:9000` locally). Because
 *   `host` is the signed header, sending the same URL to `127.0.0.1:9000` gives
 *   `403 SignatureDoesNotMatch` (measured). Never assemble or repair this URL from
 *   pieces, and never derive a media URL from a key: PUT the string
 *   `POST /uploads` handed back, and store only the `publicUrl` that
 *   `POST /uploads/complete` hands back.
 */
export async function putPresignedObject(uploadUrl: string, body: Blob, contentType: string): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body,
    credentials: 'omit',
    mode: 'cors',
  })

  if (response.ok) return

  /**
   * A failure here is MinIO's XML error document, not our envelope, so nothing in
   * this file can parse it — and the raw body is not fit to forward either: S3-family
   * `<Message>` fields quote the canonical request and the signature it calculated,
   * which is exactly the kind of internals the API's error handler keeps off the wire.
   * `<Code>` is a short token (`AccessDenied`, `SignatureDoesNotMatch`,
   * `SlowDown`…) and is the only part lifted out.
   */
  const raw = await response.text()
  const storageCode = /<Code>\s*([^<]+?)\s*<\/Code>/.exec(raw)?.[1]

  throw new ApiError(
    response.status,
    /**
     * A client-side code, deliberately *not* in `ERROR_CODES`: the portal API never
     * emits it, and adding it to the shared contract would imply a server that does.
     * Callers show the message and never branch on this.
     */
    'PRESIGNED_PUT_FAILED',
    undefined,
    storageCode
      ? `对象存储拒绝了这次上传（HTTP ${response.status}，${storageCode}）。直传签名的有效期由服务端配置（MEDIA_PRESIGN_TTL_SECONDS，默认 60 秒），过期了就重新选一次文件。`
      : `对象存储拒绝了这次上传（HTTP ${response.status}）。直传签名的有效期由服务端配置（MEDIA_PRESIGN_TTL_SECONDS，默认 60 秒），过期了就重新选一次文件。`,
  )
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
