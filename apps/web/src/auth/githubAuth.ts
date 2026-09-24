import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

export async function startGithubLogin(redirectTo: string) {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'github',
    options: {
      redirectTo,
    },
  });

  return { data, error };
}

export async function exchangeCodeForSessionFromUrl(currentUrl: string) {
  const url = new URL(currentUrl);
  const code = url.searchParams.get('code');

  if (!code) {
    return { session: null as Session | null, cleanedUrl: currentUrl, exchanged: false };
  }

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  url.searchParams.delete('code');
  url.searchParams.delete('state');

  return {
    session: error ? null : (data.session ?? null),
    cleanedUrl: url.toString(),
    exchanged: true,
    error,
  };
}

export async function getCurrentSession() {
  const { data, error } = await supabase.auth.getSession();
  return { session: data.session ?? null, error };
}

export function onAuthChange(handler: (session: Session | null) => void) {
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((_event, session) => {
    handler(session);
  });

  return () => subscription.unsubscribe();
}

export async function logout() {
  return supabase.auth.signOut();
}

