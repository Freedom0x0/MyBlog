import type { NextConfig } from 'next'

/**
 * Where the portal API lives *from the server's point of view*.
 *
 * One value feeds both halves: the server-side data layer (`lib/api.ts`, which
 * imports the same env var) and the browser-facing proxy below. The browser never
 * learns a second API host — it calls same-origin `/api/v1`, exactly as design D-3
 * requires, and this rewrite carries it to the API.
 *
 * Same-origin matters for more than tidiness: `apps/api` answers CORS for one
 * explicit origin (`PORTAL_WEB_ORIGIN`, default `http://localhost:5175` — the SPA)
 * with `credentials: true`. A fetch from `http://localhost:3000` straight to
 * `http://127.0.0.1:3001` would be refused by that single-origin allow list, and
 * making it pass would mean widening a server-side auth surface for a dev port.
 * The rewrite keeps the session cookie first-party and leaves CORS out of it.
 */
const API_INTERNAL_URL =
  (process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3001/api/v1').replace(/\/+$/, '')

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  async rewrites() {
    return [
      {
        source: '/api/v1/:path*',
        destination: `${API_INTERNAL_URL}/:path*`,
      },
      {
        /**
         * The feed is served by `app/rss/route.ts` and reached as `/rss.xml`.
         *
         * Not a style choice: a directory literally named `rss.xml` is rejected by
         * Next 16 as an invalid segment — measured, the build failed with
         * "Invalid segment configuration ... segments ['app/rss.xml/route.ts'] that's
         * reserved", because a path segment carrying a dot is read as a reserved
         * static file. The rewrite keeps the conventional, discoverable URL (the one
         * `layout.tsx` advertises in `<link rel="alternate">` and that readers paste)
         * while the handler lives at a name the router accepts.
         */
        source: '/rss.xml',
        destination: '/rss',
      },
    ]
  },

  // `output: 'standalone'` is NOT on by default, and the reason is measured: with it
  // on, `next start` prints `"next start" does not work with "output: standalone"
  // configuration.` and points at `.next/standalone/server.js`. So it is gated on an
  // env var that only the container image sets (`apps/web-next/Dockerfile` runs
  // `node server.js`, never `next start`).
  //
  // Why gated rather than simply set: the dev loop, `pnpm -r build` and the Playwright
  // suite all go through `next start`, and an unconditional `standalone` would break
  // three of them to serve one. Why the container needs it at all: without standalone,
  // the runtime image has to copy Next's whole dev-time `node_modules` closure, which
  // is the difference between a ~200 MB image and an image that carries its own
  // dependencies and nothing else.
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined,

  // Loopback-by-default is the rule for every other process in this repo (`apps/api`
  // binds 127.0.0.1 in `server.ts`), and the standalone server reads `HOSTNAME` for
  // its bind address — whose default is `0.0.0.0`. `infra/docker-compose.prod.yml`
  // therefore sets `HOSTNAME=127.0.0.1` explicitly; if that line is ever removed, the
  // container starts listening on every interface of the host.
}

export default config
