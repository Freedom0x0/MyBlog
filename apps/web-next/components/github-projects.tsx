'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'

// Define the GitHub project type
interface GithubProject {
  id: number
  name: string
  description: string
  html_url: string
  stargazers_count: number
  language: string
}

/**
 * The GitHub account whose public repositories the "开源项目" section lists.
 *
 * Named once and used once, same as the SPA: this string was previously pasted into a
 * fetch URL *and* three fallback links, which is how it went stale in four places at
 * once.
 */
const GITHUB_OWNER = 'Freedom0x0'

/**
 * `apps/web/src/pages/Home.tsx`'s projects section, ported as it stands — including
 * the decision to keep it **browser-side**.
 *
 * It is not server-rendered on purpose: it is third-party content, not this blog's
 * content, so it is not what S4 needs in the HTML, and moving it to the server would
 * put an un-authenticated 60 req/hour github.com call on every page view and every ISR
 * regeneration instead of on each visitor. Defect D11 (fetch repos server-side and
 * cache them) still owns that change.
 */
export default function GitHubProjects() {
  const [projects, setProjects] = useState<GithubProject[]>([])
  const [loadingProjects, setLoadingProjects] = useState(true)

  useEffect(() => {
    const fetchProjects = async () => {
      try {
        /**
         * No auth header: the third-party `provider_token` that used to be attached
         * here was only present on the login round trip, so it was already gone on the
         * next page load — the anonymous 60 requests/hour limit applied almost all the
         * time and this only hid that.
         */
        const response = await fetch(
          `https://api.github.com/users/${GITHUB_OWNER}/repos?sort=updated&per_page=6`,
        )

        if (response.ok) {
          setProjects((await response.json()) as GithubProject[])
        } else {
          // Rate limit, downtime, a renamed account — the section says "拉不到" and
          // leaves it at that. A stale list is worse than an empty one because it
          // reads as fact.
          console.warn(`GitHub repos unavailable (${response.status}); showing an empty section.`)
        }
      } catch (error) {
        console.error('Failed to fetch GitHub projects:', error)
      } finally {
        setLoadingProjects(false)
      }
    }

    fetchProjects()
  }, [])

  if (loadingProjects) {
    return (
      <div className="flex justify-center py-10">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    )
  }

  if (projects.length === 0) {
    /**
     * The honest third state. Without it a failed fetch rendered the heading and then
     * nothing at all, which is indistinguishable from "this person has no
     * repositories" — a claim about the author the page is not entitled to make.
     */
    return (
      <div className="py-10 mb-20 text-center text-sm text-muted-foreground">
        暂时拉不到 GitHub 仓库列表（接口限流或不可达）。稍后刷新即可，这里不放占位内容。
      </div>
    )
  }

  return (
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
  )
}
