import { fetchArticleList } from '@/lib/api'
import HeroCarousel from '@/components/hero-carousel'
import HomeIntro from '@/components/home-intro'
import GitHubProjects from '@/components/github-projects'
import LatestArticles from '@/components/latest-articles'

/**
 * The staleness window (design D-4: 60 seconds, no on-demand invalidation).
 *
 * A literal here, not `REVALIDATE_SECONDS` from the data layer: Next's segment-config
 * extractor reads exports statically and rejects an imported value — measured, the
 * build said ``The `revalidate` value should be a number.`` So the number exists twice,
 * and these two files are the only places it is written. Changing one without the
 * other makes the page cache and the fetch cache disagree, which shows up as the page
 * being fresher or staler than the design says, not as an error.
 */
export const revalidate = 60 // = REVALIDATE_SECONDS in lib/api.ts

/**
 * The SPA's `LIST_LIMIT` (`apps/web/src/utils/articlesApi.ts`): one page of 50, no
 * pagination control anywhere on the homepage, and `next` (the cursor) ignored.
 */
const LIST_LIMIT = 50

/** `articles.slice(0, 6)` in the SPA's `<HeroCarousel …>` call. */
const HERO_SLIDES = 6

/**
 * The homepage — `/`, unchanged from the SPA's route set (design D-1).
 *
 * This is a Server Component, and that is the stage: the article list is fetched here
 * and rendered into the HTML the server writes, so `curl` finds the titles without
 * running JavaScript. The pieces that need a browser — the swiper carousel, the
 * intro's `whileInView`, the GitHub repos — are client components and are *still*
 * rendered on the server for the first paint; only their interactivity waits.
 *
 * The one thing deliberately not server-rendered is the projects section: it is
 * github.com's content, not this blog's, and moving it here would put an anonymous
 * 60 req/hour call in front of every page view. Defect D11 owns that move.
 */
export default async function HomePage() {
  const { articles, unavailable } = await fetchArticleList(LIST_LIMIT)

  return (
    <div className="min-h-screen bg-background text-foreground transition-colors duration-300">
      <HeroCarousel articles={articles.slice(0, HERO_SLIDES)} unavailable={unavailable} />

      <main className="max-w-7xl mx-auto px-4 py-20">
        <HomeIntro />

        {articles.length === 0 && (
          /**
           * The SPA had one box here reading "文章加载失败或无数据" for both cases, which
           * is the conflation S3 already fixed once in `HeroCarousel`: a blog with no
           * articles is not a blog whose API is down, and only one of those two
           * sentences is a claim this page can check.
           */
          <div className="mb-10 bg-card/50 p-6 rounded-xl border border-border text-center">
            <p className="text-muted-foreground">
              {unavailable
                ? '暂时拉不到文章列表（接口不可达）。稍后刷新即可，这里不放占位内容。'
                : '这里还没有文章。'}
            </p>
          </div>
        )}

        {/* GitHub Projects Section */}
        <h2 className="text-2xl md:text-3xl font-bold mb-10 flex items-center">
          <span className="w-8 h-1 bg-primary mr-4 rounded-full"></span>
          开源项目
        </h2>
        <GitHubProjects />

        <LatestArticles articles={articles} />
      </main>

      <footer className="py-12 border-t border-border text-center text-muted-foreground text-sm">
        <p>© 2024 GuoShaoran. Built with React &amp; GSAP.</p>
      </footer>
    </div>
  )
}
