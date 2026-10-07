import HeroCarousel from '../components/HeroCarousel';
import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../store/authStore';
import { listArticles } from '../utils/articlesApi';
import type { ArticleSummary } from 'shared';
import { Link } from 'react-router-dom';

// Define the GitHub project type
interface GithubProject {
  id: number;
  name: string;
  description: string;
  html_url: string;
  stargazers_count: number;
  language: string;
}

/**
 * The GitHub account whose public repositories the "开源项目" section lists.
 *
 * Named once and used once on purpose: this string was previously pasted inline
 * into a fetch URL *and* into three fallback links, which is how it went stale in
 * four places at once — the account is `Freedom0x0`, and the old value made
 * `api.github.com/users/<name>/repos` answer 404 on every page load.
 */
const GITHUB_OWNER = 'Freedom0x0';

export default function Home() {
  const [projects, setProjects] = useState<GithubProject[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const { isAdmin } = useAuthStore();

  const [articles, setArticles] = useState<ArticleSummary[]>([]);
  const [loadingArticles, setLoadingArticles] = useState(true);

  useEffect(() => {
    const fetchProjects = async () => {
      try {
        /**
         * No auth header: the third-party `provider_token` that used to be attached
         * here was only present on the login round trip, so it was already gone on
         * the next page load — the anonymous 60 requests/hour limit applied almost
         * all the time and this only hid that.
         *
         * Properly fixing it means fetching repos server-side and caching them,
         * which is defect D11 and belongs with the write path work, not here.
         */
        const response = await fetch(
          `https://api.github.com/users/${GITHUB_OWNER}/repos?sort=updated&per_page=6`,
        );

        if (response.ok) {
          const data = await response.json();
          setProjects(data);
        } else {
          // Rate limit, downtime, a renamed account — the section says "拉不到" and
          // leaves it at that. It used to swap in a hardcoded snapshot of three
          // repositories instead, and that snapshot had rotted in place: one repo
          // renamed, one deleted, and all three pointing at an account that no
          // longer exists. A stale list is worse than an empty one because it reads
          // as fact.
          console.warn(`GitHub repos unavailable (${response.status}); showing an empty section.`);
        }
      } catch (error) {
        console.error('Failed to fetch GitHub projects:', error);
      } finally {
        setLoadingProjects(false);
      }
    };

    fetchProjects();
  }, []);

  useEffect(() => {
    const load = async () => {
      setLoadingArticles(true);
      const data = await listArticles();
      setArticles(data);
      setLoadingArticles(false);
    };
    load();
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground transition-colors duration-300">
      <HeroCarousel articles={articles.length ? articles.slice(0, 6) : []} loading={loadingArticles} />
      <main className="max-w-7xl mx-auto px-4 py-20">
        <div className="flex flex-col md:flex-row items-center justify-between gap-12 mb-20">
          <motion.div
            initial={{ opacity: 0, x: -50 }}
            whileInView={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.8 }}
            className="flex-1"
          >
            <h1 className="text-4xl md:text-6xl font-bold mb-6">
              探索技术的世界
            </h1>
            <p className="text-muted-foreground text-lg md:text-xl leading-relaxed">
              这里记录了我在 React、TypeScript 和 Web 动画领域的研究与实践。
              欢迎来到我的个人博客，一起探索现代 Web 开发的魅力。
            </p>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            whileInView={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.8 }}
            className="relative"
          >
            <div className="w-64 h-64 md:w-80 md:h-80 rounded-full overflow-hidden border-4 border-primary/20">
              <img
                src="https://coresg-normal.trae.ai/api/ide/v1/text_to_image?prompt=cool%20modern%20developer%20avatar%20minimalist%20style%20dark%20theme&image_size=square"
                alt="Avatar"
                className="w-full h-full object-cover"
              />
            </div>
          </motion.div>
        </div>

        {articles.length === 0 && !loadingArticles && (
          <div className="mb-10 bg-card/50 p-6 rounded-xl border border-border text-center">
            <p className="text-muted-foreground">文章加载失败或无数据，请稍后重试。</p>
          </div>
        )}

        {/* GitHub Projects Section */}
        <h2 className="text-2xl md:text-3xl font-bold mb-10 flex items-center">
          <span className="w-8 h-1 bg-primary mr-4 rounded-full"></span>
          开源项目
        </h2>

        {loadingProjects ? (
          <div className="flex justify-center py-10">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        ) : projects.length === 0 ? (
          /**
           * The honest third state. Without it a failed fetch rendered the heading
           * and then nothing at all, which is indistinguishable from "this person
           * has no repositories" — a claim about the author that the page is not
           * entitled to make.
           */
          <div className="py-10 mb-20 text-center text-sm text-muted-foreground">
            暂时拉不到 GitHub 仓库列表（接口限流或不可达）。稍后刷新即可，这里不放占位内容。
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 mb-20">
            {projects.map((project) => (
              <motion.div
                key={project.id}
                whileHover={{ y: -5 }}
                className="bg-card rounded-2xl p-6 border border-border hover:border-primary/50 transition-colors group cursor-pointer"
                onClick={() => window.open(project.html_url, '_blank', 'noopener,noreferrer')}
              >
                <div className="flex justify-between items-start mb-4">
                  <h3 className="text-xl font-bold group-hover:text-primary transition-colors">
                    {project.name}
                  </h3>
                  <div className="flex items-center text-muted-foreground">
                    <svg className="w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                    </svg>
                    <span>{project.stargazers_count}</span>
                  </div>
                </div>
                <p className="text-muted-foreground text-sm mb-6 line-clamp-2 h-10">
                  {project.description || '暂无描述'}
                </p>
                <div className="flex items-center">
                  <span className="text-xs px-2 py-1 bg-secondary rounded-md text-secondary-foreground">
                    {project.language || 'Unknown'}
                  </span>
                </div>
              </motion.div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between mb-10">
          <h2 className="text-2xl md:text-3xl font-bold flex items-center">
            <span className="w-8 h-1 bg-primary mr-4 rounded-full"></span>
            最新文章
          </h2>
          {isAdmin && (
            <Link
              to="/admin/articles/new"
              className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-md hover:bg-primary/90 transition-colors"
            >
              新建文章
            </Link>
          )}
        </div>

        {loadingArticles ? (
          <div className="flex justify-center py-10">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {articles.map((article) => (
              <motion.div
                key={article.slug}
                whileHover={{ y: -10 }}
                className="bg-card rounded-2xl overflow-hidden border border-border hover:border-primary/50 transition-colors group"
              >
                <div className="h-48 overflow-hidden relative">
                  {article.coverImage ? (
                    <img
                      src={article.coverImage}
                      alt={article.title}
                      className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
                    />
                  ) : (
                    /**
                     * `coverImage` is nullable in the contract, and `src={x ?? ''}` fed
                     * an empty string to `<img>` — the browser's broken-image slot where
                     * a plain block belongs. Same handling the article detail page got in
                     * D-1; every seeded article is in this branch today.
                     */
                    <div className="w-full h-full bg-gradient-to-br from-muted to-secondary" />
                  )}
                  <div className="absolute top-4 left-4">
                    <span className="px-3 py-1 bg-primary text-primary-foreground text-[10px] font-bold uppercase rounded-full">
                      {article.category}
                    </span>
                  </div>
                </div>
                <div className="p-6">
                  <h3 className="text-xl font-bold mb-3 line-clamp-2">{article.title}</h3>
                  <p className="text-muted-foreground text-sm mb-6 line-clamp-3">{article.excerpt}</p>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      {new Date(article.publishedAt).toLocaleDateString()}
                    </span>
                    <Link
                      to={`/blog/${article.slug}`}
                      className="text-primary text-sm font-semibold hover:text-primary/80 transition-colors"
                    >
                      阅读更多 →
                    </Link>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </main>

      <footer className="py-12 border-t border-border text-center text-muted-foreground text-sm">
        <p>© 2024 GuoShaoran. Built with React & GSAP.</p>
      </footer>
    </div>
  );
}
