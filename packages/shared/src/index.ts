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

  /** Domain codes, stable additions for the article, comment and auth modules. */
  articleNotFound: 'ARTICLE_NOT_FOUND',
  invalidCursor: 'INVALID_CURSOR',
  invalidState: 'INVALID_STATE',
  oauthDenied: 'OAUTH_DENIED',
  oauthExchangeFailed: 'OAUTH_EXCHANGE_FAILED',
  oauthProfileFailed: 'OAUTH_PROFILE_FAILED',
  csrfCheckFailed: 'CSRF_CHECK_FAILED',

  /**
   * A create or rename collided with an existing slug. Surfaced as 409 so a
   * client can distinguish "pick another slug" from a generic conflict — and,
   * critically, so the Postgres `23505` that actually fired stays in the
   * database. The client branches on this, never on a SQLSTATE.
   */
  slugConflict: 'SLUG_CONFLICT',

  /**
   * A comment's `parentId` referenced a comment on a different article. Declared
   * here so the write-path contract is complete; implemented in stage B.
   */
  invalidCommentParent: 'INVALID_COMMENT_PARENT',
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

/**
 * ── API DTOs ─────────────────────────────────────────────────────────────────
 *
 * Plain interfaces, not Zod schemas, for one specific reason: `apps/web` should
 * not need `zod` installed merely to name a response type, yet the API does need
 * runtime validation. So the contract lives here and the validator lives in the
 * API, and `AssertEquivalent` below is what stops the two from drifting apart —
 * a route whose schema diverges fails `tsc`, not a runtime assertion.
 *
 * Wire format is camelCase throughout; the database is snake_case and that
 * translation happens only in the repository.
 */

export interface ArticleSummary {
  slug: string
  title: string
  excerpt: string
  category: string
  tags: string[]
  coverImage: string | null
  readTime: number
  publishedAt: string
}

export interface ArticleDetail extends ArticleSummary {
  content: string
}

/**
 * Cursor pagination envelope. `next` is null on the last page rather than
 * absent, so a client can stop without comparing against an empty array.
 */
export interface ArticlePage {
  data: ArticleSummary[]
  next: { cursor: string } | null
  limit: number
}

export type ArticleStatus = 'draft' | 'published' | 'archived'

/**
 * An article as the admin write API returns it.
 *
 * Shaped like `ArticleDetail` but with two differences that exist because this
 * view is allowed to see drafts:
 * - `status` and `updatedAt` are exposed (the public contract hides both), and
 * - `publishedAt` is nullable. A draft legitimately has none, and `ArticleDetail`
 *   makes it required because the public endpoint only ever serves published
 *   articles. Reusing the non-null shape here would force the write path to
 *   fabricate a timestamp for every draft just to satisfy a serializer.
 */
export interface ArticleAdmin {
  slug: string
  title: string
  excerpt: string
  category: string
  tags: string[]
  coverImage: string | null
  readTime: number
  publishedAt: string | null
  content: string
  status: string
  updatedAt: string
}

/**
 * Body of `POST /api/v1/articles`.
 *
 * Deliberately carries no `status`: creation always lands a draft, so a client
 * cannot publish by naming the status (design §1.1 — the anti-"accidental
 * publish" rule). Unknown keys are stripped by the schema, so a `status` sent
 * anyway is discarded rather than rejected.
 */
export interface CreateArticleInput {
  slug: string
  title: string
  excerpt: string
  content: string
  category: string
  tags: string[]
  coverImage?: string | null
  readTime?: number
}

/**
 * Body of `PATCH /api/v1/articles/:slug`. Every field is optional — a patch
 * carries only what changed. This is the *only* endpoint allowed to move `status`,
 * and changing `slug` is permitted because comments hang off `article_id`, not the
 * slug text (D10).
 */
export interface UpdateArticleInput {
  slug?: string
  title?: string
  excerpt?: string
  content?: string
  category?: string
  tags?: string[]
  coverImage?: string | null
  readTime?: number
  status?: ArticleStatus
}

export interface CommentAuthor {
  /**
   * The author's user id.
   *
   * Present so the client can decide "is this mine?" without the server rendering
   * that flag per viewer — that decision is a permission check and belongs to the
   * requester's own identity. `login` cannot substitute for it: it is a display
   * name the person can change, and comparing an internal uuid against a login
   * silently never matches.
   */
  id: string
  login: string
  displayName: string | null
  avatarUrl: string | null
}

/**
 * Flat with a `parentId` pointer; the client assembles the tree. Nesting depth
 * is small, and this keeps the read path to a single indexed query instead of a
 * recursive CTE per page view.
 */
export interface CommentNode {
  id: string
  articleId: string
  parentId: string | null
  content: string
  author: CommentAuthor
  createdAt: string
}

export interface CommentList {
  data: CommentNode[]
}

export interface TagCount {
  tag: string
  count: number
}

export interface TagList {
  data: TagCount[]
}

/**
 * Compile-time equality check: `A extends B` AND `B extends A`.
 *
 * Structural typing lets two shapes differ in optionality and still pass a
 * one-directional check, so both directions are asserted.
 */
export type AssertEquivalent<A, B> =
  [A] extends [B] ? ([B] extends [A] ? true : false) : false

/**
 * The signed-in identity, as returned by `GET /api/v1/auth/me`.
 *
 * `isAdmin` is included so the client stops guessing membership from a username
 * constant baked into the bundle — the front-end half of defect D1. It is read
 * from the database per request, so revoking an admin takes effect on the next
 * page load rather than whenever a token happens to expire.
 */
export interface SessionUser {
  id: string
  login: string
  displayName: string | null
  avatarUrl: string | null
  isAdmin: boolean
}

