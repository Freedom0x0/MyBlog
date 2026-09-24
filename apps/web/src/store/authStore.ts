import { create } from 'zustand';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

interface User {
  id: string;
  email?: string;
  user_metadata: {
    full_name?: string;
    avatar_url?: string;
    user_name?: string;
    // GitHub also exposes the login under this key; it is declared here rather
    // than cast at each use site.
    preferred_username?: string;
  };
}

interface AuthState {
  user: User | null;
  session: Session | null;
  isAdmin: boolean;
  loading: boolean;
  setUser: (user: User | null, session?: Session | null) => void;
  signOut: () => Promise<void>;
}

const ADMIN_GITHUB_USERNAME = 'guoshaoran';

function getUserName(user: User | null) {
  const meta = user?.user_metadata;
  return meta?.user_name || meta?.preferred_username || meta?.full_name || '';
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  session: null,
  isAdmin: false,
  loading: true,
  setUser: (user, session = null) => {
    const isAdmin = getUserName(user) === ADMIN_GITHUB_USERNAME;
    set({ user, session, isAdmin, loading: false });
  },
  signOut: async () => {
    await supabase.auth.signOut();
    set({ user: null, session: null, isAdmin: false, loading: false });
  },
}));
