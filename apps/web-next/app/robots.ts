import type { MetadataRoute } from 'next'
import { publicOrigin } from '../lib/site'

/**
 * `GET /robots.txt`.
 *
 * `force-dynamic` for the same reason as the sitemap (D-3): the sitemap URL has to
 * carry the real origin, and a build-time prerender would bake whatever
 * `NEXT_PUBLIC_SITE_URL` said at that moment into a file that ships forever.
 *
 * `/admin` is disallowed even though the SPA serves it, not this app: robots.txt is
 * read per **origin**, and one origin is hosting both front ends (design D-1). A
 * crawler that follows `/admin/articles` would be fetching session-gated screens
 * that answer 401/redirect, which is wasted crawl budget at best.
 *
 * This is a politeness signal, not an access control — the real gate on `/admin/*`
 * is `requireAdmin` on the API and the fact that the data simply is not there for an
 * anonymous caller.
 */
export const dynamic = 'force-dynamic'

export default function robots(): MetadataRoute.Robots {
  const origin = publicOrigin()

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/admin', '/api/'],
      },
    ],
    sitemap: `${origin}/sitemap.xml`,
  }
}
