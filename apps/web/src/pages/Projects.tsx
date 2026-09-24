import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Github, Star, GitFork, ExternalLink } from 'lucide-react';

interface Repo {
  id: number;
  name: string;
  description: string;
  html_url: string;
  stargazers_count: number;
  forks_count: number;
  language: string;
  topics: string[];
}

const Projects: React.FC = () => {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('https://api.github.com/users/guoshaoran/repos?sort=updated&per_page=100')
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) {
          const sortedRepos = data
            .filter(repo => !repo.fork)
            .sort((a, b) => b.stargazers_count - a.stargazers_count);
          setRepos(sortedRepos);
        }
        setLoading(false);
      })
      .catch(err => {
        console.error('Error fetching repos:', err);
        setLoading(false);
      });
  }, []);

  return (
    <div className="min-h-screen bg-skin-base pt-24 pb-20 px-4">
      <div className="max-w-7xl mx-auto">
        <header className="mb-16">
          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-4xl md:text-6xl font-black text-skin-base tracking-tighter mb-4"
          >
            OPEN SOURCE <span className="text-blue-500">PROJECTS</span>
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="text-skin-muted text-lg max-w-2xl"
          >
            A collection of my experiments, tools, and side projects from GitHub.
          </motion.p>
        </header>

        {loading ? (
          <div className="flex justify-center items-center h-64">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {repos.map((repo, index) => (
              <motion.a
                key={repo.id}
                href={repo.html_url}
                target="_blank"
                rel="noopener noreferrer"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05 }}
                className="group block p-6 bg-skin-muted rounded-2xl border border-transparent hover:border-blue-500/30 transition-all duration-300"
              >
                <div className="flex justify-between items-start mb-4">
                  <Github className="w-8 h-8 text-skin-muted group-hover:text-blue-500 transition-colors" />
                  <ExternalLink className="w-5 h-5 text-skin-muted opacity-0 group-hover:opacity-100 transition-all" />
                </div>
                <h3 className="text-xl font-bold text-skin-base mb-2 group-hover:text-blue-500 transition-colors">
                  {repo.name}
                </h3>
                <p className="text-skin-muted text-sm mb-6 line-clamp-2 h-10">
                  {repo.description || 'No description provided.'}
                </p>
                <div className="flex items-center gap-4 text-xs font-mono text-skin-muted">
                  <span className="flex items-center gap-1">
                    <Star className="w-3 h-3" /> {repo.stargazers_count}
                  </span>
                  <span className="flex items-center gap-1">
                    <GitFork className="w-3 h-3" /> {repo.forks_count}
                  </span>
                  {repo.language && (
                    <span className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-500">
                      {repo.language}
                    </span>
                  )}
                </div>
              </motion.a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default Projects;