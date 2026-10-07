import { z } from 'zod'
import type { AssertEquivalent, SessionUser } from 'shared'

export const SessionUserSchema = z.object({
  id: z.uuid(),
  login: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  isAdmin: z.boolean(),
})

export const MeSchema = z.object({ user: SessionUserSchema })

export const USER_MATCHES_CONTRACT: AssertEquivalent<
  z.infer<typeof SessionUserSchema>,
  SessionUser
> = true
