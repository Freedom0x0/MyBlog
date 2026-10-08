import type { MetadataRoute } from 'next'
import { fetchAllPublished } from '../lib/api'
import { articlePath, publicOrigin } from '../lib/site'

/**
 * `GET /sitemap.xml` — every published article, plus the homepage.
 *
 * `force-dynamic` is required, not stylistic (design D-3): a prerendered sitemap
 * would be generated during `next build`, where the API is deliberately not
 * reachable in CI — the artifact would then be an empty file baked into the
 * deployment, which is the worst failure mode for a discovery mechanism because
 * nothing errors.
 *
 * `lastmod` uses `publishedAt` because that is the newest timestamp the public
 * contract carries: `ArticleSummary` (`packages/shared/src/index.ts:97`) has
 * `publishedAt` and no `updatedAt`, so an edit does not claim to be a new article.
 * Exposing `updatedAt` here would mean widening the public DTO for a
 * nice-to-have, which is a stage-C decision on its own and not made silently.
 *
 * Drafts cannot appear: the public list endpoint only ever returns published ones
 * (`GET /api/v1/articles` is filtered server-side, and a draft slug 404s).
 */
export const dynamic = 'force-dynamic'
// No `revalidate` here, deliberately: exporting both `dynamic = 'force-dynamic'`
// and `revalidate` is a contradictory segment configuration, and Next 16 fails the
// build over it while printing only "Invalid segment configuration export
// detected ... You should see the relevant failures in the logs above" — with
// nothing above. `force-dynamic` is the one that matters for D-3, and a sitemap is
// cheap to generate per request.

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = publicOrigin()
  const { articles, unavailable } = await fetchAllPublished()

  const home: MetadataRoute.Sitemap = [
    {
      url: `${origin}/`,
      changeFrequency: 'daily',
      priority: 1,
    },
  ]

  if (unavailable) {
    // The homepage entry still goes out; a transient API failure must not make the
    // whole domain look un-listed to a crawler that retries in an hour.
    console.warn('[web-next] sitemap built without articles: the API was unreachable')
    return home
  }

  return [
    ...home,
    ...articles.map((article) => ({
      url: `${origin}${articlePath(article.slug)}`,
      lastModified: new Date(article.publishedAt),
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    })),
  ]
}
