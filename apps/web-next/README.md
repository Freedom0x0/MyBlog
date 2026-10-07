# apps/web-next

The public pages of this blog — `/` and `/blog/:slug` — rendered on the server.
`apps/web` (the Vite SPA) keeps carrying `/admin/*`; the split and its reasons are in
`.trellis/tasks/10-08-s4-nextjs-public-pages/design.md` (D-1, P-2).

## Run it

```
corepack pnpm@12.4.1 --filter web-next dev      # http://localhost:3000, bound to 127.0.0.1
corepack pnpm@12.4.1 --filter web-next build
corepack pnpm@12.4.1 --filter web-next start    # production server, same loopback bind
```

`API_INTERNAL_URL` defaults to the local API (`http://127.0.0.1:3001/api/v1`), so with
`apps/api` running there is nothing to configure. See `.env.example`.

**Open it as `http://localhost:3000`, not `http://127.0.0.1:3000`.** The session cookie
is scoped by host, not port, and the SPA you are switching between lives on
`http://localhost:5175` — reached by `127.0.0.1` you get two cookie jars and appear
logged out in one of them.

Why `corepack pnpm@12.4.1` and not `pnpm`: the `pnpm` on PATH in this environment is
broken; the repo pins `packageManager: pnpm@12.4.1`.

## What this app is for

The measured starting point (2026-10-08): `curl`ing a real published article's URL on
the SPA returned **841 bytes** with an empty `<div id="root">` and **zero** hits of that
article's own words. Search engines and link-preview bots read exactly those bytes.
So the deliverable here is not "a Next app exists" — it is:

```
curl -s localhost:3000/blog/normal-published | grep -c '小节'          # > 0
curl -s localhost:3000/                    | grep -c '一篇普通的入门文章'  # > 0
```

Both are true, and they are true of the *server's* HTML: no browser is involved, and the
article body arrives through a Server Component (`components/article-body.tsx` runs
`react-markdown` + `rehype-sanitize` with no `'use client'` anywhere in the file).

## Two things that will bite anyone who edits this app

### design tokens

`app/globals.css` line 1 is `@import "design-tokens/tokens.css";` — the same line the
SPA's `src/index.css` opens with. **In Next it needs a bundler that is configured
differently, and both failure modes are silent or misleading:**

- Vite's failure mode (already hit in this repo): if the `@import` sits *after* the
  `@tailwind` directives, `vite:css` prints one warning and drops the whole token block.
  The build stays green and the CSS is ~1 kB smaller.
- Next/Turbopack's failure mode (hit while building this app): Turbopack turns a CSS
  `@import` into its own module and runs the PostCSS chain over it **in isolation**, and
  Tailwind v3 refuses a lone `@layer base` with no matching `@tailwind base`:

  ```
  CssSyntaxError: packages/design-tokens/tokens.css:1:1:
  `@layer base` is used but no matching `@tailwind base` directive is present.
  ```

  The fix is `postcss-import` listed **before** `tailwindcss` in `postcss.config.mjs`,
  which restores the shape Vite hands Tailwind (one stylesheet, import already inlined).
  `packages/design-tokens` itself is untouched, so `apps/web` is unaffected.

Verify, rather than trusting:

```
grep -c -- '--background'                 apps/web-next/.next/static/chunks/*.css
grep -c -- '--primary:217.2 91.2% 59.8%'  apps/web-next/.next/static/chunks/*.css   # .dark, minified
grep -c 'text-muted-foreground'           apps/web-next/.next/static/chunks/*.css   # shared preset → utility
```

Note the path: **Turbopack writes CSS to `.next/static/chunks/*.css`, not
`.next/static/css/*.css`.** And it minifies, so `--primary: 217.2…` (with the space the
source has) does not match — grep the value, not the spacing.

Also in that config file: the plugins are named as **strings**. Importing
`tailwindcss`/`autoprefixer` and passing instances makes Turbopack bundle Tailwind's CJS
and rewrite its `__dirname`, after which the build dies on
`ENOENT: …'C:\ROOT\…\tailwindcss\lib\css\preflight.css'`.

### Tailwind stays on v3

`tailwind.config.js` loads the shared colour map through
`presets: [require("design-tokens/tailwind-preset")]`. Tailwind v4 removed both
`presets` and JS config, so a v4 bump here silently orphans the shared token map.
`content` stays app-local on purpose — a preset carrying one app's globs makes Tailwind
purge classes the other app actually renders.

## Data flow

| what | where it runs | module |
| --- | --- | --- |
| article list, article detail | server (RSC), `revalidate = 60` | `lib/api.ts` |
| markdown → HTML, sanitised | server (RSC) | `components/article-body.tsx` |
| comments, `/auth/me` | browser, same-origin `/api/v1` | `lib/client-api.ts` |
| GitHub repos | browser (`api.github.com`) | `components/github-projects.tsx` |

`lib/api.ts` is the only server module that talks to the API. Two of its properties are
load-bearing:

- **An unreachable API is not an error.** `next build` pre-renders `/`, and CI has
  postgres/redis/minio but no api process (design D-3). Every read failure becomes
  `{ articles: [], unavailable: true }` plus a `console.warn`, so the build succeeds and
  the page renders the degraded empty state. Prove it with:
  `API_INTERNAL_URL=http://127.0.0.1:1 pnpm --filter web-next build`.
- **"Empty" is two states.** `unavailable: true` is "we could not ask"; an empty list
  with `unavailable: false` is "this blog has no articles". Only the second one is a
  claim about the blog. (Same rule S3 learned from `HeroCarousel`'s `loading` prop.)

Comments stay client-fetched on purpose (design D-5): they are per-visitor and
login-gated, so they do not belong in a 60-second page cache, and no `commentCount` was
added to the backend to work around that.

## Cache window

`export const revalidate = 60` on both article-bearing routes, i.e. **a publish or an
edit is visible to the outside world within 60 seconds** (design D-4). There is no
on-demand invalidation, deliberately: the write path is in `apps/api`, so it would need
a shared-secret endpoint callable from the API whose failure mode looks like "published
successfully but nothing happened". The trigger to revisit is the author complaining
about the one-minute wait.

`revalidate` has to be a **literal** — Next's segment-config extractor reads those
exports statically and rejects `export const revalidate = REVALIDATE_SECONDS` with
``The `revalidate` value should be a number``. The number therefore appears in three
files (two routes + `REVALIDATE_SECONDS` in `lib/api.ts`, which is what the `fetch`
cache uses); keep them in step by hand.

## Two dev-only gaps

Both are consequences of the port topology (design D-1), not bugs in this app, and both
disappear once nginx splits by path on one origin:

1. **`/admin/*` links 404 here.** The header's 文章管理 and the homepage's 新建文章
   point at `/admin/…`, which is the SPA — on port 5175 in dev, same-origin in
   production.
2. **Sign-in lands on the SPA.** `GET /api/v1/auth/github/start` is proxied to the API
   fine, but after the OAuth callback the API redirects to `PORTAL_WEB_ORIGIN`, whose
   default is `http://localhost:5175` (`apps/api/src/config/index.ts:69`). So a login
   started from port 3000 finishes on port 5175. The cookie is then shared, because the
   host matches (`localhost`) — see the note above about not using `127.0.0.1`.

## Deliberately not here

- `robots.txt`, `sitemap.xml`, `rss.xml` — stage C of this task, the next sub-agent's
  work. `generateMetadata` for the two pages built here *is* here, because a page
  without its own title/description is the defect this stage exists to fix.
- `SplashScreen` (the gsap particle intro the SPA shows once per session) — not in the
  port list, and it is a full-screen delay in front of exactly the content this stage
  is trying to get into the first bytes.
- `output: 'standalone'` — see the comment in `next.config.ts`.
- Admin affordances on the detail page (进入编辑器 / 快速编辑 / the MDEditor panel) —
  `/admin/*` stays on the SPA (scope ruling P-2), so the public page renders the
  published article and nothing else.
- `next/image`: every image URL here is outside this app's control (object-store hosts
  from `MEDIA_PUBLIC_BASE_URL`, GitHub avatars, the SPA's baked-in avatar URL), and
  `next/image` needs an enumerated `remotePatterns` list. The image pipeline is
  explicitly a later stage. `@next/next/no-img-element` is off in
  `eslint.config.mjs` with that reason written down.

## Commands

```
corepack pnpm@12.4.1 --filter web-next lint     # eslint . (Next 16 has no `next lint`)
corepack pnpm@12.4.1 --filter web-next check    # tsc --noEmit
corepack pnpm@12.4.1 --filter web-next build    # next build (Turbopack)
```

`tsconfig.json` extends the repo's `tsconfig.base.json` for the shared strictness flags
and overrides the module/JSX settings Next needs. It does **not** extend
`apps/api/tsconfig.json`: that one switches to `moduleResolution: nodenext`, which
demands `.js` extensions on every relative import and is wrong for a bundled app.
