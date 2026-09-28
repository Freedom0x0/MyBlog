import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let client: SupabaseClient | null = null

/**
 * Whether sign-in is configured at all.
 *
 * Callers use this to *skip* the auth bootstrap instead of letting it throw. The
 * lazy `getSupabase` fixed when the exception happens, not whether the app can
 * start: `App.tsx` calls `onAuthChange` synchronously in its mount effect, so a
 * throw there still unmounted the tree — with no error boundary, a blank page.
 * Browsing needs the API, not Supabase; this makes that true.
 */
export function hasSupabaseCredentials(): boolean {
  return Boolean(
    import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY,
  )
}

/**
 * Lazily constructed, and only for what still lives in Supabase: GitHub OAuth
 * until S2, and comment/article writes until S3.
 *
 * This module now backs exactly one thing: `upsertArticle`, the last write still
 * going to Supabase. Sign-in moved to the portal API in S2, and the remaining
 * writes move in S3, at which point this file goes away.
 *
 * It is constructed lazily because the eager version threw at module scope when
 * the env vars were absent, and since the auth module was imported by `App.tsx`
 * that throw ran while loading the bundle: a fresh clone with no `.env` rendered
 * nothing at all, even though reading articles needs nothing from Supabase.
 */
export function getSupabase(): SupabaseClient {
  if (client !== null) return client

  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

  if (!url || !anonKey) {
    throw new Error(
      'Supabase credentials are required for sign-in and writing.\n' +
        '  Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in apps/web/.env',
    )
  }

  client = createClient(url, anonKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
      persistSession: true,
    },
  })

  return client
}
