import { create } from 'zustand';
import type { SessionUser } from 'shared';
import { fetchMe, logout as apiLogout } from '../utils/authApi';

interface AuthState {
  user: SessionUser | null;
  isAdmin: boolean;
  /** True until the first /auth/me round trip settles, so the header does not flash. */
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

/**
 * Client-side reflection of the server session.
 *
 * `isAdmin` is copied from /auth/me rather than derived from a username compared
 * in the browser. The previous version hard-coded ADMIN_GITHUB_USERNAME and matched
 * it against user_metadata — the UI half of defect D1: anyone could set their own
 * metadata, so the check was decorative for display *and* was the only thing the
 * old admin editor trusted for a comfortable UX. The server's RLS was the real gate,
 * and it read the same writable field.
 *
 * This store is still only UX. Hiding a button is not access control; requireAdmin
 * on the API is what enforces anything.
 */
export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAdmin: false,
  loading: true,
  refresh: async () => {
    try {
      const user = await fetchMe();
      set({ user, isAdmin: user?.isAdmin ?? false, loading: false });
    } catch (error) {
      // A failed identity lookup leaves the visitor logged out rather than
      // crashing the page; articles do not depend on knowing who they are.
      console.error('session lookup failed', error);
      set({ user: null, isAdmin: false, loading: false });
    }
  },
  signOut: async () => {
    await apiLogout();
    const user = await fetchMe().catch(() => null);
    set({ user, isAdmin: false });
  },
}));
