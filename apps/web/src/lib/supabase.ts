import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let client: SupabaseClient | null = null

/**
 * Lazily constructed, and only for what still lives in Supabase: GitHub OAuth
 * until S2, and comment/article writes until S3.
 *
 * The previous version called `createClient` at module scope and threw when the
 * env vars were absent. Because `App.tsx` imports the auth module, that throw ran
 * while loading the bundle — so a fresh clone with no `.env` could not render the
 * homepage at all, even though reading articles needs nothing from Supabase.
 *
 * Deferring construction means the failure happens where it belongs: when someone
 * actually clicks login.
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
