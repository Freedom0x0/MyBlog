import { z } from 'zod'
import type {
  ArticleDetail,
  ArticlePage,
  ArticleSummary,
  AssertEquivalent,
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
