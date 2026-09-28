import { z } from 'zod'
import type { AssertEquivalent, CommentList, CommentNode } from 'shared'

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

export const NODE_MATCHES_CONTRACT: AssertEquivalent<
  z.infer<typeof CommentNodeSchema>,
  CommentNode
> = true

export const LIST_MATCHES_CONTRACT: AssertEquivalent<
  z.infer<typeof CommentListSchema>,
  CommentList
> = true
