import { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import SplashScreen from './components/SplashScreen';
import Home from './pages/Home';
import ArticleDetail from './pages/ArticleDetail';
import AdminArticleEditor from './pages/AdminArticleEditor';
import AdminArticleList from './pages/AdminArticleList';
import { AnimatePresence } from 'framer-motion';
import { useAuthStore } from './store/authStore';
import Header from './components/Header';

function App() {
  const [showSplash, setShowSplash] = useState(true);
  const refresh = useAuthStore((state) => state.refresh);

  useEffect(() => {
    const hasShownSplash = sessionStorage.getItem('hasShownSplash');
    if (hasShownSplash) {
      setShowSplash(false);
    }

    /**
     * One question to the API on mount: is there a session cookie?
     *
     * Replaces the old third-party auth bootstrap, which had to exchange an OAuth
     * code in the address bar and subscribe to auth events. The callback now
     * completes on the API, so the SPA only ever reads the resulting session —
     * nothing to parse out of the URL, and no client-side token storage.
     */
    void refresh();
  }, [refresh]);

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
        {/* The list comes before :slug/edit only for readability — React Router v6
            ranks static segments above dynamic ones, so /admin/articles/new still
            resolves to the editor and not to this page. */}
        <Route path="/admin/articles" element={<AdminArticleList />} />
        <Route path="/admin/articles/new" element={<AdminArticleEditor />} />
        <Route path="/admin/articles/:slug/edit" element={<AdminArticleEditor />} />
      </Routes>
    </Router>
  );
}

export default App;
