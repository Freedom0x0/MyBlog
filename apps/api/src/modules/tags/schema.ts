import { z } from 'zod'
import type { AssertEquivalent, TagCount, TagList } from 'shared'

export const TagCountSchema = z.object({
  tag: z.string(),
  count: z.number().int().min(0),
})

export const TagListSchema = z.object({
  data: z.array(TagCountSchema),
})

export const TagParamsSchema = z.object({
  // Bounded, because the value also becomes a query parameter downstream.
  tag: z.string().min(1).max(60),
})

export const COUNT_MATCHES_CONTRACT: AssertEquivalent<
  z.infer<typeof TagCountSchema>,
  TagCount
> = true

export const LIST_MATCHES_CONTRACT: AssertEquivalent<
  z.infer<typeof TagListSchema>,
  TagList
> = true
