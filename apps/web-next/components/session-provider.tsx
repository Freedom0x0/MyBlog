'use client'

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SessionUser } from 'shared'
import { fetchMe, signOut as apiSignOut } from '@/lib/client-api'

/**
 * One `/auth/me` round trip per page view, shared by everything that needs to know
 * who is looking.
 *
 * The SPA keeps this in a zustand store; a context is the same idea without adding a
 * dependency for one value. `loading` is exposed rather than hidden because the header
 * and the comment form both need to avoid flashing "登录" at a visitor who is already
 * signed in — the same "loading is a state worth naming" rule that `HeroCarousel` got
 * in S3.
 *
 * Session state is *presentation*, never permission: `POST /comments` and
 * `DELETE /comments/:id` answer 401/403 from the server regardless of what this hook
 * believes. Hiding a button is not access control.
 */
interface SessionState {
  user: SessionUser | null
  isAdmin: boolean
  /** True until the first `/auth/me` round trip settles. */
  loading: boolean
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}

const SessionContext = createContext<SessionState | null>(null)

/**
 * Ask the API who this is, and treat "could not ask" as "nobody".
 *
 * 401 already means not-signed-in inside `fetchMe` and comes back as `null`; anything
 * else (API down, proxy error) is logged and answered the same way, because reading an
 * article does not depend on knowing who the visitor is.
 */
async function readSession(): Promise<SessionUser | null> {
  try {
    return await fetchMe()
  } catch (error) {
    console.error('session lookup failed', error)
    return null
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setUser(await readSession())
    setLoading(false)
  }, [])

  /**
   * The mount-time read is written out instead of delegating to `refresh()`, and that
   * is a React-19 rule rather than a style preference: `react-hooks/set-state-in-effect`
   * (eslint-plugin-react-hooks 7, which is what `eslint-config-next` ships) rejects a
   * `useState` setter reached indirectly from an effect body. Same request, same
   * states, one more line — and the `cancelled` guard is the part that was missing
   * from the SPA's version, where a fast unmount could land the answer on a dead tree.
   */
  useEffect(() => {
    let cancelled = false

    void readSession().then((next) => {
      if (cancelled) return
      setUser(next)
      setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [])

  const signOut = useCallback(async () => {
    // `apiSignOut` already treats a 401 as "the session was already gone"; a real
    // failure rethrows and the caller in Header.tsx surfaces it instead of looking
    // like a clean logout.
    await apiSignOut()
    await refresh()
  }, [refresh])

  const value: SessionState = {
    user,
    isAdmin: user?.isAdmin ?? false,
    loading,
    refresh,
    signOut,
  }

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionState {
  const context = useContext(SessionContext)
  if (context === null) {
    throw new Error('useSession must be used inside <SessionProvider>')
  }
  return context
}
