import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import './globals.css'
import Header from '@/components/header'
import { SessionProvider } from '@/components/session-provider'

/**
 * Site-level metadata. The per-article half lives in `app/blog/[slug]/page.tsx`'s
 * `generateMetadata`, and that is the point of this app existing: the SPA's `<title>`
 * was the only meta a crawler ever got.
 *
 * `title.template` is what turns `generateMetadata({ title: article.title })` into
 * "一篇普通的入门文章 | Guoshaoran" without every page repeating the site name.
 */
export const metadata: Metadata = {
  title: {
    default: 'Guoshaoran',
    template: '%s | Guoshaoran',
  },
  // Carried over verbatim from `apps/web/index.html`'s meta description, so the
  // homepage says the same thing about itself as it always has.
  description: 'Guoshaoran 的个人博客：技术文章、开源项目与实践笔记。',
  // Absolute `og:url` / `canonical` need a public origin. Without it Next emits the
  // path as given, which is useless to a crawler but honest; dev leaves it unset.
  metadataBase: process.env.NEXT_PUBLIC_SITE_URL
    ? new URL(process.env.NEXT_PUBLIC_SITE_URL)
    : undefined,
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

/**
 * Applies the stored theme before the first paint.
 *
 * The SPA did not need this: `useTheme` ran its effect after mount and the page had
 * already painted. Here the HTML is produced on a server that cannot know about
 * `localStorage`, so without this script every dark-mode reader gets a light flash
 * and, worse, the `.dark` token block never applies to the server-rendered markup the
 * stage gates look at. Default is `dark` because that is what `hooks/use-theme.ts`
 * defaults to; the two must agree.
 */
const themeInitScript = `(function(){try{var t=window.localStorage.getItem('theme');document.documentElement.classList.remove('light','dark');document.documentElement.classList.add(t==='light'?'light':'dark');}catch(e){document.documentElement.classList.add('dark');}})();`

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    // `zh-CN`, where the SPA's index.html said `lang="en"` over Chinese copy. The
    // whole reason for this stage is machines reading the markup; a language
    // attribute that contradicts the text is a wrong answer to give them.
    // `suppressHydrationWarning` because the script above mutates `class` before React
    // gets here, and React 19 compares it.
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <SessionProvider>
          <Header />
          {children}
        </SessionProvider>
      </body>
    </html>
  )
}
