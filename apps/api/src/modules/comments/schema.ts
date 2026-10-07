import { z } from 'zod'
import type {
  AssertEquivalent,
  CommentList,
  CommentNode,
  CreateCommentInput,
} from 'shared'

export const CommentNodeSchema = z.object({
  id: z.uuid(),
  articleId: z.uuid(),
  parentId: z.uuid().nullable(),
  content: z.string(),
  author: z.object({
    id: z.uuid(),
    login: z.string(),
    displayName: z.string().nullable(),
    avatarUrl: z.string().nullable(),
  }),
  createdAt: z.iso.datetime(),
})

export const CommentListSchema = z.object({
  data: z.array(CommentNodeSchema),
})

export const SlugParamsSchema = z.object({
  slug: z.string().min(1).max(200),
})

/**
 * `COMMENT_MAX_LENGTH` mirrors the database `check` in migration 0001. Named here
 * so the DTO bound and the test bound cannot drift from each other silently; the
 * database keeps its own copy because it has to hold the rule against writers that
 * never pass through this file (S3-R6 double guard).
 */
export const COMMENT_MIN_LENGTH = 1
export const COMMENT_MAX_LENGTH = 4000

/**
 * Comment body. `parentId` must be a uuid if present; whether it is *legitimate*
 * (same article, still exists) is a rule the service settles in SQL — the shape
 * check here only says "not a typo, not a SQL fragment".
 */
export const CreateCommentSchema = z.object({
  content: z
    .string()
    .min(COMMENT_MIN_LENGTH)
    .max(COMMENT_MAX_LENGTH)
    // A comment of only whitespace is not "empty" to `length(content) between 1 and
    // 4000` — three spaces measure 3 and pass both the column check and the DTO's
    // own min, so the row used to be written and design §6's "空正文 → 400" was only
    // half true. The refine rejects it without trimming the stored value: what a
    // reader typed is what a reader sees.
    .refine((value) => value.trim().length > 0, {
      message: `comment content must contain at least one non-whitespace character`,
    }),
  parentId: z.uuid().nullable().optional(),
})

/** A comment id is a uuid, so a malformed one is refused as 400 here. */
export const CommentIdParamsSchema = z.object({
  id: z.uuid(),
})

/**
 * Drift guards, exported for the same reason the article ones are: `noUnusedLocals`
 * would reject an unused const, and an unexported guard is a guard that never
 * compiles. If `CommentNodeSchema` or `CreateCommentSchema` ever disagrees with the
 * `shared` interface, this file stops type-checking instead of a client noticing.
 */
export const NODE_MATCHES_CONTRACT: AssertEquivalent<
  z.infer<typeof CommentNodeSchema>,
  CommentNode
> = true

export const LIST_MATCHES_CONTRACT: AssertEquivalent<
  z.infer<typeof CommentListSchema>,
  CommentList
> = true

export const CREATE_MATCHES_CONTRACT: AssertEquivalent<
  z.infer<typeof CreateCommentSchema>,
  CreateCommentInput
> = true
