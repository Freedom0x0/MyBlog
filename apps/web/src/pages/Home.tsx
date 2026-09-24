import HeroCarousel from '../components/HeroCarousel';
import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../store/authStore';
import { listArticles, type ArticleRecord } from '../utils/articlesApi';
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

const FALLBACK_PROJECTS: GithubProject[] = [
  {
    id: 1132046393,
    name: "CareerCraftHub-vue2",
    description: "Vue2 career platform",
    html_url: "https://github.com/guoshaoran/CareerCraftHub-vue2",
    stargazers_count: 0,
    language: "Vue"
  },
  {
    id: 1099107578,
    name: "My-Platform",
    description: "a project made by vue and cursor",
    html_url: "https://github.com/guoshaoran/My-Platform",
    stargazers_count: 0,
    language: "Vue"
  },
  {
    id: 1044262775,
    name: "phaser-game",
    description: "Phaser based web game",
    html_url: "https://github.com/guoshaoran/phaser-game",
    stargazers_count: 0,
    language: "JavaScript"
  }
];

export default function Home() {
  const [projects, setProjects] = useState<GithubProject[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const { session, isAdmin } = useAuthStore();

  const [articles, setArticles] = useState<ArticleRecord[]>([]);
  const [loadingArticles, setLoadingArticles] = useState(true);

  useEffect(() => {
    const fetchProjects = async () => {
      try {
        const headers: Record<string, string> = {};
        
        // Use provider token if available to get higher rate limit
        if (session?.provider_token) {
          headers['Authorization'] = `token ${session.provider_token}`;
        }

        const response = await fetch('https://api.github.com/users/guoshaoran/repos?sort=updated&per_page=6', {
          headers
        });

        if (response.ok) {
          const data = await response.json();
          setProjects(data);
        } else if (response.status === 403) {
          const errorData = await response.json();
          if (errorData.message.includes('rate limit exceeded')) {
            console.warn('GitHub API rate limit exceeded, using fallback projects.');
            setProjects(FALLBACK_PROJECTS);
          }
        }
      } catch (error) {
        console.error('Failed to fetch GitHub projects:', error);
        setProjects(FALLBACK_PROJECTS);
      } finally {
        setLoadingProjects(false);
      }
    };

    fetchProjects();
  }, [session]);

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
      <HeroCarousel articles={articles.length ? articles.slice(0, 6) : []} />
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
                key={article.id}
                whileHover={{ y: -10 }}
                className="bg-card rounded-2xl overflow-hidden border border-border hover:border-primary/50 transition-colors group"
              >
                <div className="h-48 overflow-hidden relative">
                  <img
                    src={article.cover_image ?? ''}
                    alt={article.title}
                    className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
                  />
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
                      {new Date(article.created_at).toLocaleDateString()}
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
