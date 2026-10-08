import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, Calendar, Clock, Tag } from 'lucide-react'
import { fetchArticle } from '@/lib/api'
import ArticleBody from '@/components/article-body'
import CommentsSection from '@/components/comments-section'
import { formatDateUTC } from '@/lib/format'

/**
 * `/blog/[slug]` — the same URL the SPA serves (`App.tsx:46`), now with its body in
 * the server's HTML.
 *
 * No `generateStaticParams`: with none, Next renders this route on the first real
 * request and caches it for `revalidate` seconds, which is exactly what design D-3
 * asks for — `next build` then never contacts the API for a detail page, so a CI
 * runner with postgres/redis/minio and no api process still builds. The homepage is
 * the route that has to survive a build-time read, and it does by degrading.
 *
 * Literal `60`, for the same reason as the homepage: Next's segment-config extractor
 * reads this export statically and rejects an imported constant.
 */
export const revalidate = 60 // = REVALIDATE_SECONDS in lib/api.ts

interface RouteProps {
  /** `params` is a Promise in the App Router as of Next 15. */
  params: Promise<{ slug: string }>
}

/**
 * Per-article metadata, from the article itself (S4-R4).
 *
 * This is the half the SPA could never do: its HTML carried one site-level `<title>`
 * and no description, so every shared link looked identical to a link preview bot.
 * `og:image` is omitted rather than invented when `coverImage` is null — every seeded
 * article is in that branch today.
 */
export async function generateMetadata({ params }: RouteProps): Promise<Metadata> {
  const { slug } = await params
  const { article, unavailable } = await fetchArticle(slug)

  if (article === null) {
    // Two different sentences for two different facts, matching the page below: a
    // missing article is `404`, an unreadable API is not a statement about the article.
    return unavailable ? { title: '文章读取失败' } : { title: '文章未找到' }
  }

  return {
    title: article.title,
    description: article.excerpt,
    alternates: { canonical: `/blog/${article.slug}` },
    openGraph: {
      title: article.title,
      description: article.excerpt,
      type: 'article',
      url: `/blog/${article.slug}`,
      ...(article.coverImage === null ? {} : { images: [{ url: article.coverImage }] }),
    },
  }
}

export default async function ArticlePage({ params }: RouteProps) {
  const { slug } = await params
  const { article, unavailable } = await fetchArticle(slug)

  if (article === null) {
    if (unavailable) {
      /**
       * Degraded: the API could not be read.
       *
       * Rendered in place with the SPA's own failure wording instead of throwing, and
       * deliberately *not* via `notFound()`. `notFound()` answers 404, which is a
       * claim that this URL has no content — a claim an unreachable upstream does not
       * entitle the page to make, and one a crawler would remember. The trade-off is
       * honest and worth naming: this response carries status 200.
       */
      return (
        <div className="min-h-screen flex flex-col items-center justify-center bg-background text-foreground">
          <h1 className="text-4xl font-bold mb-4">文章读取失败</h1>
          <p className="mb-4 text-muted-foreground">
            暂时连不上文章接口，稍后刷新即可。这不是说这篇文章不存在。
          </p>
          <Link href="/" className="text-primary hover:underline">
            返回首页
          </Link>
        </div>
      )
    }

    // A genuine "no published article with that slug" — 404, and `app/not-found.tsx`
    // is what renders it. The API answers 404 for a draft too, and that is correct
    // here: an anonymous reader must not be able to tell the two apart.
    notFound()
  }

  return (
    <div className="min-h-screen bg-background text-foreground selection:bg-primary/30">
      {/* Header Image */}
      <div className="relative h-[40vh] md:h-[60vh] w-full overflow-hidden">
        {article.coverImage ? (
          <img src={article.coverImage} alt={article.title} className="w-full h-full object-cover" />
        ) : (
          /**
           * `coverImage` is nullable in the contract — the column is nullable and the
           * API answers `null`, not `''`. The SPA's local type called it a `string`,
           * so this `<img src>` got an empty string and the browser's broken-image
           * placeholder landed where a plain gradient belongs.
           */
          <div className="w-full h-full bg-gradient-to-br from-muted to-secondary" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/50 to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 max-w-4xl mx-auto px-4 pb-8">
          <Link
            href="/"
            className="inline-flex items-center text-muted-foreground hover:text-foreground mb-6 transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            返回首页
          </Link>
          <div className="mb-6">
            <h1 className="text-3xl md:text-5xl font-bold text-foreground">{article.title}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-6 text-sm text-muted-foreground">
            <div className="flex items-center">
              <Calendar className="w-4 h-4 mr-2" />
              {formatDateUTC(article.publishedAt)}
            </div>
            <div className="flex items-center">
              <Clock className="w-4 h-4 mr-2" />
              {article.readTime} 分钟阅读
            </div>
            <div className="flex items-center">
              <Tag className="w-4 h-4 mr-2" />
              {article.category}
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <main className="max-w-4xl mx-auto px-4 py-12">
        {/* The markdown body, sanitised and rendered on the server. */}
        <ArticleBody content={article.content} />

        {/* Footer Tags */}
        <div className="mt-12 pt-8 border-t border-border">
          <div className="flex flex-wrap gap-2">
            {article.tags.map((tag) => (
              <span
                key={tag}
                className="px-3 py-1 bg-secondary text-secondary-foreground text-xs rounded-full border border-border"
              >
                #{tag}
              </span>
            ))}
          </div>
        </div>

        {/* Comments Section — client-fetched by design (D-5): per-visitor, login-gated
            to post, and not part of what this page's HTML is for. */}
        <CommentsSection slug={article.slug} />
      </main>
    </div>
  )
}
