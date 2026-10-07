/**
 * The public origin this site is reached at, used only to make URLs absolute
 * (`sitemap.xml`, `rss.xml`, `og:url`, `canonical`).
 *
 * Why an env var and not the request's `Host` header: a crawler is supposed to see
 * one canonical origin. Trusting `Host` means whatever a visitor's DNS points at
 * gets baked into the sitemap, and a spoofed header gets a sitemap that advertises
 * somebody else's domain — the same reason `apps/api` configures `API_PUBLIC_URL`
 * rather than deriving the OAuth `redirect_uri` from the header (see the comment on
 * that key in `apps/api/src/config/index.ts:52`).
 *
 * The fallback is the dev origin, deliberately: with nothing set, `next dev` still
 * emits a well-formed sitemap instead of failing a local run for a production
 * concern. The warning fires only outside development, because a missing value in
 * production *is* a misconfiguration — relative entries would otherwise be
 * silently accepted by every consumer.
 */
const FALLBACK_ORIGIN = 'http://localhost:3000'

let warned = false

export function publicOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL

  if (configured !== undefined && configured !== '') {
    return configured.replace(/\/+$/, '')
  }

  if (process.env.NODE_ENV !== 'development' && !warned) {
    warned = true
    console.warn(
      '[web-next] NEXT_PUBLIC_SITE_URL is unset in a non-development process; ' +
        `falling back to ${FALLBACK_ORIGIN}. Set it before deploy or the sitemap/OG URLs will be wrong.`,
    )
  }

  return FALLBACK_ORIGIN
}

/** One published article's canonical path. Kept here so feed and sitemap cannot disagree. */
export function articlePath(slug: string): string {
  return `/blog/${encodeURIComponent(slug)}`
}
