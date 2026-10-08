'use client'

import Link from 'next/link'
import { motion } from 'framer-motion'
import type { ArticleSummary } from 'shared'
import { formatDateUTC } from '@/lib/format'
import { useSession } from '@/components/session-provider'

/**
 * The "最新文章" section of `apps/web/src/pages/Home.tsx`, ported.
 *
 * A client component because `motion.div`'s `whileHover` needs one: framer-motion
 * registers listeners and writes inline styles. That does not move the article list
 * out of the server HTML — Next renders client components on the server for the first
 * paint, so the titles, excerpts and links are in the bytes `curl` gets, and only the
 * hover animation waits for JavaScript.
 */
export default function LatestArticles({ articles }: { articles: ArticleSummary[] }) {
  const { isAdmin } = useSession()

  return (
    <>
      <div className="flex items-center justify-between mb-10">
        <h2 className="text-2xl md:text-3xl font-bold flex items-center">
          <span className="w-8 h-1 bg-primary mr-4 rounded-full"></span>
          最新文章
        </h2>
        {isAdmin && (
          <Link
            href="/admin/articles/new"
            className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-md hover:bg-primary/90 transition-colors"
          >
            新建文章
          </Link>
        )}
      </div>

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
                 * `coverImage` is nullable in the contract; feeding `''` to `<img src>`
                 * put the browser's broken-image slot where a plain block belongs.
                 * Every seeded article is in this branch today.
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
                  {formatDateUTC(article.publishedAt)}
                </span>
                <Link
                  href={`/blog/${article.slug}`}
                  className="text-primary text-sm font-semibold hover:text-primary/80 transition-colors"
                >
                  阅读更多 →
                </Link>
              </div>
            </div>
          </motion.div>
        ))}
      </div>
    </>
  )
}
