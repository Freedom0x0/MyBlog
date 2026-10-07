import { useAuthStore } from '../store/authStore';
import { useTheme } from '../hooks/useTheme';
import { Moon, Sun } from 'lucide-react';
import { Link } from 'react-router-dom';
import { loginUrl } from '../utils/authApi';

export default function Header() {
  const { user, isAdmin } = useAuthStore();
  const { theme, toggleTheme } = useTheme();

  const displayName = user?.login ?? '访客';

  /**
   * A whole-page navigation, not a fetch: the browser must leave for the provider
   * and return to the API's callback, which a background request cannot do.
   */
  const handleLogin = () => {
    window.location.assign(loginUrl(window.location.pathname));
  };

  const handleLogout = async () => {
    try {
      await useAuthStore.getState().signOut();
    } catch (error) {
      // Surfaced rather than swallowed: a logout that silently failed leaves the
      // visitor believing they are signed out on a shared machine.
      console.error('logout failed', error);
      window.alert('退出失败，请重试');
    }
  };

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container max-w-7xl mx-auto flex h-14 items-center justify-between px-4">
        <div className="flex items-center space-x-4">
          <a href="/" className="font-bold text-xl flex items-center space-x-2">
            <span className="bg-primary text-primary-foreground px-2 py-1 rounded-md text-sm">G</span>
            <span>Guoshaoran</span>
          </a>
        </div>

        <div className="flex items-center space-x-4">
          <button
            onClick={toggleTheme}
            className="p-2 rounded-full hover:bg-accent transition-colors"
            title="切换主题"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          {user ? (
            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-2">
                {user.avatarUrl ? (
                  <img
                    src={user.avatarUrl}
                    alt={displayName}
                    className="w-8 h-8 rounded-full border border-border"
                  />
                ) : (
                  /**
                   * The same empty-`src` class already removed from the article cards
                   * and the comment list: `avatarUrl` is nullable in the contract, and
                   * the seeded admin (or any session created before avatars were
                   * captured) has none. An initial in a circle beats a broken image.
                   */
                  <span
                    aria-hidden="true"
                    className="w-8 h-8 rounded-full border border-border bg-primary/20 text-primary text-sm font-semibold flex items-center justify-center"
                  >
                    {displayName.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="text-sm font-medium hidden sm:inline-block">
                  {displayName}
                </span>
                {isAdmin && (
                  <span className="px-2 py-0.5 text-xs bg-primary/20 text-primary rounded-full">
                    Admin
                  </span>
                )}
              </div>
              {isAdmin && (
                /**
                 * The way into /admin/articles. Without this link the list page is
                 * reachable only by typing the URL: the header used to offer the
                 * avatar, the Admin badge and 登出 — nothing that led to the back
                 * office at all, which is what S3-R22's list page would otherwise
                 * have been built behind.
                 */
                <Link
                  to="/admin/articles"
                  className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  文章管理
                </Link>
              )}
              <button
                onClick={handleLogout}
                className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                登出
              </button>
            </div>
          ) : (
            <button
              onClick={handleLogin}
              className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-md hover:bg-primary/90 transition-colors flex items-center space-x-2"
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" aria-hidden="true">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.285 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"></path>
              </svg>
              <span>GitHub 登录</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
