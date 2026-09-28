import { apiGet, apiPost, ApiError } from '../lib/apiClient'
import type { SessionUser } from 'shared'

/**
 * Session reads and teardown go through the portal API.
 *
 * Sign-in does not: it is a whole-page navigation to the API's OAuth start
 * endpoint, not a fetch. The browser must leave for github.com and come back to
 * the API's callback, which a background request cannot do.
 */

export async function fetchMe(): Promise<SessionUser | null> {
  try {
    const { user } = await apiGet<{ user: SessionUser }>('/auth/me')
    return user
  } catch (error) {
    // 401 here means "not signed in", which is a normal state, not a fault.
    if (error instanceof ApiError && error.status === 401) return null
    throw error
  }
}

export async function logout(): Promise<void> {
  try {
    await apiPost<{ ok: boolean }>('/auth/logout')
  } catch (error) {
    // A session already ended server-side is a success from the user's point of
    // view; anything else should surface rather than look like a clean logout.
    if (error instanceof ApiError && error.status === 401) return
    throw error
  }
}

/** Absolute URL, because leaving the SPA requires a navigation, not a request. */
export function loginUrl(returnTo: string): string {
  const base = apiBase()
  return `${base}/auth/github/start?return_to=${encodeURIComponent(returnTo)}`
}

function apiBase(): string {
  const configured = import.meta.env.VITE_API_BASE_URL as string | undefined
  return (configured ?? 'http://localhost:3001/api/v1').replace(/\/$/, '')
}
