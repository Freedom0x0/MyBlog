import { z } from 'zod'
import type {
  ArticleAdmin,
  ArticleDetail,
  ArticlePage,
  ArticleStatus,
  ArticleSummary,
  AssertEquivalent,
  CreateArticleInput,
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
