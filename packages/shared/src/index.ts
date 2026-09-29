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
   * A comment's `parentId` referenced a comment on a different article, or one
   * that is no longer there. 400 rather than 404: the caller's own request is the
   * thing that is wrong, and a reply target is not a resource they are entitled to
   * probe for existence either way.
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
 * One row of `GET /api/v1/admin/articles` — `ArticleAdmin` without `content`.
 *
 * Defined by subtraction rather than spelled out again so the two cannot drift:
 * anything added to the admin article shape appears in the list shape too, which
 * is exactly what a list-row type should mean.
 *
 * The subtraction itself is the point. A page of up to fifty articles carrying
 * fifty full markdown bodies is megabytes per request that no list UI renders —
 * one of this repository's own seed fixtures is a 117 KiB article — and the
 * repository's explicit column list exists precisely so a payload cannot widen by
 * accident (see `LIST_COLUMNS` in the articles repository). What the admin list
 * does need is the two fields the public summary has never carried — `status`
 * (which row is a draft?) and `updatedAt` (when did I last touch it?) — because
 * "sort by most recently changed and show me the state" is the whole reason this
 * endpoint exists.
 */
export type AdminArticleSummary = Omit<ArticleAdmin, 'content'>

/**
 * Cursor page of admin list rows. Same envelope as {@link ArticlePage} on purpose:
 * `next` is null on the last page rather than absent, and `limit` echoes what the
 * caller asked for.
 *
 * Note the `data` type differs from `ArticlePage`, not just its size — so this is
 * a second interface rather than a type parameter on the first. Keeping the two
 * separate means the public list can never start serving draft rows.
 */
export interface AdminArticlePage {
  data: AdminArticleSummary[]
  next: { cursor: string } | null
  limit: number
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

/**
 * ── Markdown import (`POST /api/v1/articles/import`) ──────────────────────────
 *
 * One entry per file the person picked in the admin page. The *raw* markdown text
 * travels, not parsed fields: parsing happens server-side so there is exactly one
 * parser and exactly one write path (S3-R8 / design §3). A client-side parser
 * would be a second validator that a modified request body walks straight around.
 */
export interface ImportArticleFile {
  /**
   * The browser's `File.name`, used only to point at the offending file in a
   * result or error message. Never a path and never in SQL — a display name is
   * attacker-controlled text, and the value the client sent back is echoed to it
   * for identification and nothing else.
   */
  name: string
  markdown: string
}

export interface ImportArticlesRequest {
  files: ImportArticleFile[]
}

/**
 * A file that became a draft. `article` is the same shape `POST /api/v1/articles`
 * returns, so the admin page can render one row type for both paths — and its
 * `status` is the server's answer ("draft"), which is exactly how S3-R9 gets
 * proved to the person importing rather than asserted in prose.
 */
export interface ImportArticleCreatedResult {
  name: string
  kind: 'created'
  article: ArticleAdmin
}

/**
 * A file whose slug was already taken. Reported per file, inside an otherwise
 * 200 response (design §6): the *batch* was accepted, so the HTTP status must not
 * claim it wasn't — while earlier files in the same batch may already be written.
 * The client asks the person "overwrite?" and only then sends a `PATCH`
 * (S3-R10). No new error code is opened for this: it is data, not a failure.
 */
export interface ImportArticleConflictResult {
  name: string
  kind: 'conflict'
  /** The slug that collided — the thing the follow-up `PATCH` addresses. */
  slug: string
  /** Human-readable reason, safe to show as-is. */
  message: string
}

export type ImportArticleResult = ImportArticleCreatedResult | ImportArticleConflictResult

/**
 * Per-file results, in the order the files arrived, so the page can pair them
 * back up by position as well as by `name`.
 *
 * Wrapped in an object rather than returned as a bare array because no other
 * endpoint in this API answers with a top-level array (`ArticlePage`,
 * `CommentList`, `TagList` all wrap) and a wrapper is where a later field — a
 * count, a warning — can appear without changing the response's type.
 */
export interface ImportArticlesResponse {
  results: ImportArticleResult[]
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

/**
 * Body of `POST /api/v1/articles/:slug/comments`.
 *
 * Carries no author field on purpose: the commenter's identity comes from the
 * verified token, never from the request body. Accepting one would let any client
 * comment as anyone else, and the validator strips unknown keys so a sent
 * `user_id` is discarded rather than honoured.
 *
 * `content` is length-bound to match the database `check`
 * (`length(content) between 1 and 4000`). Both ends enforce it deliberately
 * (S3-R6): the DTO answers 400 at the boundary instead of letting a constraint
 * violation climb out of the driver as a 5xx, and the database keeps the rule for
 * every writer that bypasses this API — a future migration, a `psql` session, the
 * publish CLI. Neither is the guard; the pair is.
 */
export interface CreateCommentInput {
  content: string
  /** An existing comment on the *same* article. Cross-article trees are refused. */
  parentId?: string | null
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

