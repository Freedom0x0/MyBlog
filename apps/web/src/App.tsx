import { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import SplashScreen from './components/SplashScreen';
import Home from './pages/Home';
import ArticleDetail from './pages/ArticleDetail';
import AdminArticleEditor from './pages/AdminArticleEditor';
import { AnimatePresence } from 'framer-motion';
import { useAuthStore } from './store/authStore';
import Header from './components/Header';
import { exchangeCodeForSessionFromUrl, getCurrentSession, onAuthChange } from './auth/githubAuth';
import { hasSupabaseCredentials } from './lib/supabase';

function App() {
  const [showSplash, setShowSplash] = useState(true);
  const { setUser } = useAuthStore();

  useEffect(() => {
    const hasShownSplash = sessionStorage.getItem('hasShownSplash');
    if (hasShownSplash) {
      setShowSplash(false);
    }

    // Without credentials there is no session to restore: stay a logged-out
    // visitor and let the reads work, rather than throwing during mount.
    if (!hasSupabaseCredentials()) {
      setUser(null, null);
      return;
    }

    const initAuth = async () => {
      const exchanged = await exchangeCodeForSessionFromUrl(window.location.href);
      if (exchanged.exchanged) {
        setUser(exchanged.session?.user ?? null, exchanged.session);
        window.history.replaceState({}, document.title, exchanged.cleanedUrl);
      }

      const current = await getCurrentSession();
      setUser(current.session?.user ?? null, current.session);
    };

    initAuth().catch((error) => {
      // A failed session restore must not blank the page: the visitor is simply
      // logged out, and the content they came for is served by the portal API.
      console.error('auth init failed', error);
      setUser(null, null);
    });

    const unsubscribe = onAuthChange((session) => {
      setUser(session?.user ?? null, session);
    });

    return () => unsubscribe();
  }, [setUser]);

  const handleSplashComplete = () => {
    setShowSplash(false);
    sessionStorage.setItem('hasShownSplash', 'true');
  };

  return (
    <Router>
      <AnimatePresence>
        {showSplash && <SplashScreen onComplete={handleSplashComplete} />}
      </AnimatePresence>
      <Header />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/blog/:slug" element={<ArticleDetail />} />
        <Route path="/admin/articles/new" element={<AdminArticleEditor />} />
        <Route path="/admin/articles/:slug/edit" element={<AdminArticleEditor />} />
      </Routes>
    </Router>
  );
}

export default App;
