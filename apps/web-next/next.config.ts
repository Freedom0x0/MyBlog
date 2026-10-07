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
    ]
  },

  // `output: 'standalone'` is deliberately NOT set here, and the reason is measured:
  // with it on, `next start` prints `"next start" does not work with
  // "output: standalone" configuration.` and points at
  // `.next/standalone/server.js` — whose default bind is `0.0.0.0`, not the loopback
  // this stage requires. Standalone output is the container image's business (design
  // D-1's nginx topology, S5/S8); adding it now would make the app's own `start` script
  // a warning.
}

export default config
