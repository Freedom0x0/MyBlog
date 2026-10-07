/**
 * Date labels that mean the same thing on both sides of the SSR boundary.
 *
 * The SPA could write `new Date(x).toLocaleDateString()` because only one machine
 * ever formatted it — the visitor's. Here the same component body runs on the server
 * for the first paint and again in the browser to hydrate, and a bare
 * `toLocaleDateString()` reads *both* the runtime's default locale and its time zone:
 * a server in UTC and a reader in UTC+8 would disagree about which day an article was
 * published on, which React reports as a hydration mismatch and patches by hand.
 *
 * Pinning the locale and `timeZone: 'UTC'` makes the two renderings byte-identical.
 * `zh-CN` matches the site's own copy; the SPA's un-located call resolved to the
 * author's browser locale, which is zh-CN too.
 */
export function formatDateUTC(iso: string): string {
  return new Date(iso).toLocaleDateString('zh-CN', { timeZone: 'UTC' })
}
