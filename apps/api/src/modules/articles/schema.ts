import { z } from 'zod'
import type {
  AdminArticlePage,
  AdminArticleSummary,
  ArticleAdmin,
  ArticleDetail,
  ArticlePage,
  ArticleStatus,
  ArticleSummary,
  AssertEquivalent,
  CreateArticleInput,
  ImportArticlesRequest,
  ImportArticlesResponse,
  UpdateArticleInput,
} from 'shared'

/**
 * Query contract.
 *
 * `limit` is bounded rather than trusted: without a max, `?limit=1000000` is a
 * free way to make the server read the whole table. The ceiling is a control, not
 * a preference.
 */
export const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  cursor: z.string().min(1).max(512).optional(),
  tag: z.string().min(1).max(60).optional(),
  category: z.string().min(1).max(60).optional(),
})

export const ArticleSummarySchema = z.object({
  slug: z.string(),
  title: z.string(),
  excerpt: z.string(),
  category: z.string(),
  tags: z.array(z.string()),
  coverImage: z.string().nullable(),
  readTime: z.number().int(),
  publishedAt: z.iso.datetime(),
})

export const ArticleDetailSchema = ArticleSummarySchema.extend({
  content: z.string(),
})

export const ArticlePageSchema = z.object({
  data: z.array(ArticleSummarySchema),
  next: z.object({ cursor: z.string() }).nullable(),
  limit: z.number().int(),
})

export const SlugParamsSchema = z.object({
  slug: z.string().min(1).max(200),
})

/**
 * The status vocabulary, mirrored from the DB `check` so an out-of-vocabulary
 * value is rejected as 400 at the boundary rather than reaching Postgres and
 * surfacing as a constraint error (which would leak schema shape into a 5xx).
 */
const ArticleStatusSchema = z.enum(['draft', 'published', 'archived'])

/**
 * Create body. No `status` field, and Zod strips unknown keys, so a client that
 * sends one anyway has it discarded rather than honoured — the "creation is never
 * publication" rule (S3-R0 / design §1.1) is partly a validation decision.
 */
export const CreateArticleSchema = z.object({
  slug: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  excerpt: z.string().min(1).max(500),
  content: z.string().min(1),
  category: z.string().min(1).max(60),
  tags: z.array(z.string().min(1).max(60)),
  coverImage: z.string().nullable().optional(),
  readTime: z.number().int().positive().optional(),
})

/**
 * Update body — every field optional (a patch carries only what changed).
 * `status` is validated against the enum, so a rename to a taken slug is caught
 * downstream as SLUG_CONFLICT while a bad status word never leaves the validator.
 */
export const UpdateArticleSchema = z.object({
  slug: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(200).optional(),
  excerpt: z.string().min(1).max(500).optional(),
  content: z.string().min(1).optional(),
  category: z.string().min(1).max(60).optional(),
  tags: z.array(z.string().min(1).max(60)).optional(),
  coverImage: z.string().nullable().optional(),
  readTime: z.number().int().positive().optional(),
  status: ArticleStatusSchema.optional(),
})

/**
 * Admin response: the public detail shape plus `status`/`updatedAt`, with
 * `publishedAt` made nullable because an admin view legitimately serves drafts.
 * `status` stays a plain string on output — the column is enum-checked in the DB,
 * and reading it as `string` avoids casting the repository's `status: string`.
 */
export const ArticleAdminSchema = ArticleSummarySchema.extend({
  content: z.string(),
  publishedAt: z.iso.datetime().nullable(),
  status: z.string(),
  updatedAt: z.iso.datetime(),
})

// ── Admin reads (S3-R20 ~ S3-R21, design §1.4) ────────────────────────────────

/**
 * One row of the admin list: the admin article shape minus its body, derived by
 * `omit` for the same reason `AdminArticleSummary` is derived by `Omit` in
 * `shared` — the "no bodies in a list" rule cannot then silently stop holding
 * when a field is added to `ArticleAdminSchema`.
 */
export const AdminArticleSummarySchema = ArticleAdminSchema.omit({ content: true })

export const AdminArticlePageSchema = z.object({
  data: z.array(AdminArticleSummarySchema),
  next: z.object({ cursor: z.string() }).nullable(),
  limit: z.number().int(),
})

/**
 * Query for `GET /api/v1/admin/articles`.
 *
 * `limit` repeats the public list's bound rather than a copy of a different number:
 * the ceiling is a control on how many rows one request may read, and the admin
 * surface has no claim on a looser one (the sort key differs, the shape of the DoS
 * does not).
 *
 * `status` is validated against the enum the database `check` mirrors. Note what
 * the check is actually for, because it is not the usual one: a bad status in a
 * `where` clause cannot violate a constraint — constraints bind writes — so an
 * unvalidated value would reach SQL and match nothing. The failure it prevents is
 * therefore the misleading one, a 200 with an empty page reading as "you have no
 * archived articles" when the caller typed `Archived`. The enum turns that into a
 * 400 naming the field, which is what `AdminListQuerySchema`'s test asserts
 * (verified by removing the enum: the response becomes a 200 with `data: []`).
 */
export const AdminListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  cursor: z.string().min(1).max(512).optional(),
  status: ArticleStatusSchema.optional(),
})

/**
 * Drift guards. These are exported so `noUnusedLocals` does not reject them, and
 * they are the reason the contract can live in `shared` as plain interfaces while
 * validation stays here as Zod: if a schema and its interface ever disagree, this
 * line stops compiling instead of a runtime assertion noticing later.
 */
export const SUMMARY_MATCHES_CONTRACT: AssertEquivalent<
  z.infer<typeof ArticleSummarySchema>,
  ArticleSummary
> = true

export const DETAIL_MATCHES_CONTRACT: AssertEquivalent<
  z.infer<typeof ArticleDetailSchema>,
  ArticleDetail
> = true

export const PAGE_MATCHES_CONTRACT: AssertEquivalent<
  z.infer<typeof ArticlePageSchema>,
  ArticlePage
> = true

export const ADMIN_MATCHES_CONTRACT: AssertEquivalent<
  z.infer<typeof ArticleAdminSchema>,
  ArticleAdmin
> = true

export const ADMIN_SUMMARY_MATCHES_CONTRACT: AssertEquivalent<
  z.infer<typeof AdminArticleSummarySchema>,
  AdminArticleSummary
> = true

export const ADMIN_PAGE_MATCHES_CONTRACT: AssertEquivalent<
  z.infer<typeof AdminArticlePageSchema>,
  AdminArticlePage
> = true

export const CREATE_MATCHES_CONTRACT: AssertEquivalent<
  z.infer<typeof CreateArticleSchema>,
  CreateArticleInput
> = true

export const UPDATE_MATCHES_CONTRACT: AssertEquivalent<
  z.infer<typeof UpdateArticleSchema>,
  UpdateArticleInput
> = true

export const STATUS_MATCHES_CONTRACT: AssertEquivalent<
  z.infer<typeof ArticleStatusSchema>,
  ArticleStatus
> = true

// ── Markdown import (S3-R7 ~ S3-R11, design §3) ───────────────────────────────

/**
 * Size ceilings, named here so the DTO, the route's `bodyLimit` and the tests all
 * read the same numbers instead of three copies that drift.
 *
 * These do not defend against "an article too big to read" — markdown is plain
 * text and a single file gets 128 KiB, which is absurdly generous for a blog post.
 * They defend against a hand resting on the file picker: a few hundred files
 * submitted as one request (design §3.2).
 */
export const IMPORT_MAX_FILES = 20
export const IMPORT_MAX_MARKDOWN_BYTES = 128 * 1024
export const IMPORT_MAX_TOTAL_MARKDOWN_BYTES = 2 * 1024 * 1024
export const IMPORT_MAX_NAME_LENGTH = 255

/**
 * Route-scoped `bodyLimit` for the import endpoint — see `routes.ts`.
 *
 * The relationship to the DTO ceilings is the load-bearing part, not the exact
 * numbers: Fastify enforces `bodyLimit` while collecting the body, *before* the
 * Zod schema ever runs, so a request the DTO could have explained usefully must
 * not be stopped by the framework first. Worst case the DTO allows
 * IMPORT_MAX_TOTAL_MARKDOWN_BYTES (2 MiB) plus at most IMPORT_MAX_FILES names of
 * IMPORT_MAX_NAME_LENGTH characters — about 2.1 MiB of *content*. The wire body can
 * sit up to ~2x that (≈4.1 MiB) because JSON escapes inflate each affected byte
 * (newlines, quotes, backslashes are all single-byte, so each grows to two), never
 * shrinks — and 4.1 MiB still clears this 8 MiB ceiling: so oversized *content*
 * always gets the Zod message ("markdown exceeds the 131072-byte limit"), and the
 * framework's blunter 413 only fires on a body that is simply too big to be a real
 * import.
 *
 * It is set per route and NOT raised globally (`app.ts` leaves Fastify's default
 * 1 MiB alone): a global ceiling governs every endpoint, so lifting it would make
 * the auth routes and the health checks start accepting large bodies too, for the
 * benefit of exactly one caller.
 */
export const IMPORT_BODY_LIMIT_BYTES = 8 * 1024 * 1024

/**
 * `name` is a display name, and browsers hand us `File.name` — a basename with no
 * directory part. Path separators are therefore refused rather than filtered:
 * anything that looks like a path is either a bug in the caller or a probe, and
 * the field's only job is to point at a file in a message. Control characters are
 * refused for the same reason — they would end up echoed back into the admin page.
 * Non-ASCII (中文 filenames) is fine, which is why this is a denylist and not a
 * `[a-z0-9.-]` allowlist.
 *
 * Written as code-point comparisons rather than a character-class regex because
 * `no-control-regex` (rightly) rejects /\u0000/ ranges: this way the ban says what
 * it means and lint does not have to be told to look the other way.
 */
function hasPathSeparatorOrControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return value.includes('/') || value.includes('\\')
}

/** Byte length as the server will store and count it, not UTF-16 code units. */
function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export const ImportArticleFileSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(IMPORT_MAX_NAME_LENGTH)
    .refine((value) => !hasPathSeparatorOrControlCharacter(value), {
      message: 'name must be a bare file name, without path separators or control characters',
    }),
  markdown: z
    .string()
    .min(1)
    .refine((value) => utf8Bytes(value) <= IMPORT_MAX_MARKDOWN_BYTES, {
      message: `markdown exceeds the ${IMPORT_MAX_MARKDOWN_BYTES}-byte per-file limit`,
    }),
})

export const ImportArticlesSchema = z.object({
  files: z
    .array(ImportArticleFileSchema)
    .min(1, 'at least one markdown file is required')
    .max(IMPORT_MAX_FILES, `a single import carries at most ${IMPORT_MAX_FILES} files`)
    .refine((files) => files.reduce((total, file) => total + utf8Bytes(file.markdown), 0) <= IMPORT_MAX_TOTAL_MARKDOWN_BYTES, {
      message: `the batch exceeds the ${IMPORT_MAX_TOTAL_MARKDOWN_BYTES}-byte total limit`,
    }),
})

/**
 * Per-file outcome. Discriminated on `kind` so the client narrows with
 * `result.kind === 'created'` instead of probing for a field that may or may not
 * be there.
 *
 * A conflict is a *member of the response*, not an error status (design §6): the
 * batch was accepted and earlier files may already be drafts, so 409 for the whole
 * request would be a lie about the half that succeeded.
 */
export const ImportArticleResultSchema = z.discriminatedUnion('kind', [
  z.object({
    name: z.string(),
    kind: z.literal('created'),
    article: ArticleAdminSchema,
  }),
  z.object({
    name: z.string(),
    kind: z.literal('conflict'),
    slug: z.string(),
    message: z.string(),
  }),
])

export const ImportArticlesResponseSchema = z.object({
  results: z.array(ImportArticleResultSchema),
})

export const IMPORT_REQUEST_MATCHES_CONTRACT: AssertEquivalent<
  z.infer<typeof ImportArticlesSchema>,
  ImportArticlesRequest
> = true

export const IMPORT_RESPONSE_MATCHES_CONTRACT: AssertEquivalent<
  z.infer<typeof ImportArticlesResponseSchema>,
  ImportArticlesResponse
> = true
