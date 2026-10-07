# infra/nginx — the S5 gateway

One nginx `server` putting the three things that run separately on the deploy box
behind a single origin, plus `smoke.sh` to prove the routing rather than assume it.

| path | answer | how |
| --- | --- | --- |
| `/`, `/blog/<slug>`, `/sitemap.xml`, `/robots.txt`, `/rss.xml`, `/_next/*`, `/icon.svg` | `apps/web-next` | proxy to `127.0.0.1:3000` |
| `/admin/...` (deep links included) | `apps/web` static build | files under `/var/www/myblog/admin/` |
| `/assets/index-<hash>.js\|css` | the same `apps/web` build | see "why two locations for one SPA" |
| `/api/v1/...` | `apps/api` | proxy to `127.0.0.1:3001` |
| `/health`, `/ready` | `apps/api` | liveness / readiness, kept separate on purpose |
| media (MinIO `:9000`) | **not fronted** | known gap, bottom of `myblog.conf` |

Scope: reverse proxy + health checks + fault visibility. Portal hub, iframe
embedding, SSO/shared-cookie-domain work and sub-path module deployment are
explicitly deferred (ruling of 2026-10-08), and TLS is S8 — see the header
comment in `myblog.conf` for what is deliberately absent and why.

## Install and enable

Assumes this repo is at `/opt/myblog` on the box and nginx came from the Debian /
Ubuntu package (`sites-available` + `sites-enabled`).

```bash
# once, to place the config
sudo cp infra/nginx/myblog.conf /etc/nginx/sites-available/myblog.conf
sudo ln -sf /etc/nginx/sites-available/myblog.conf /etc/nginx/sites-enabled/myblog.conf
sudo rm -f /etc/nginx/sites-enabled/default    # it also claims `listen 80 default_server`

# every deploy: publish the admin SPA where the config expects it
sudo mkdir -p /var/www/myblog/admin
sudo rsync -a --delete --exclude '*.map' apps/web/dist/ /var/www/myblog/admin/
sudo chmod -R o+rX /var/www/myblog/admin       # nginx reads as www-data

sudo nginx -t && sudo systemctl reload nginx
```

The one command that enables the site is the `ln -sf` line; `systemctl reload`
(not `restart`) is what keeps existing connections alive. `nginx -t` before the
reload is not ceremony: this file is a *drop-in*, so a typo costs nothing until
the reload — and a failed reload leaves the old config serving, which is the good
outcome.

`--exclude '*.map'` matters. `sourcemap: 'hidden'` means the bundle carries no
`sourceMappingURL` comment, but Vite still writes `index-<hash>.js.map` (7.2 MB
measured) next to it, and `location /assets/` will serve anything in that
directory.

## Three env values the app side must agree with

The gateway's whole premise is that the browser sees ONE origin. Three settings
have to say the same thing, and they live in three different files:

| value | must be | where | what breaks if it is wrong |
| --- | --- | --- | --- |
| `PORTAL_WEB_ORIGIN` | `http://60.205.178.223` (later: the domain) | `apps/api/.env` | **Both things at once.** It is the single CORS allow-origin *and* the target the OAuth callback redirects to. **This project already had this defect:** the callback completed, the session cookie got set, and the user was dumped on the API's own 404 page — because the redirect was a relative path resolved against the API's port, i.e. `PORTAL_WEB_ORIGIN` said `http://localhost:5175` on a box where the browser is at the gateway origin. Logged in `.trellis/tasks/09-29-blog-portal-s3-write-path/implement.md`. If login "succeeds" and the admin page still says you are anonymous, look here first. |
| `API_PUBLIC_URL` | `http://60.205.178.223` | `apps/api/.env` | The absolute base the API builds its own public URLs from (it does not derive them from `Host`, which is why a spoofed Host cannot poison a redirect). Wrong value = the OAuth `redirect_uri` GitHub was never told about, so the provider refuses before anyone reaches nginx. Also register the callback as `http://60.205.178.223/api/v1/auth/github/callback` in the GitHub OAuth app — GitHub compares that string exactly, path included. |
| `VITE_API_BASE_URL` | `/api/v1` | build-time env of `apps/web` | Baked into the bundle. Left at its default (`http://localhost:3001/api/v1`) the admin UI tries to reach a port that is not open on purpose, and `curl localhost` works while the real browser does not. It is a *relative* value on purpose: same-origin is what makes CORS irrelevant here. |

Two more that the gateway does not decide but does depend on:

- `NEXT_PUBLIC_SITE_URL` (apps/web-next) → `http://60.205.178.223`. Unset, the
  sitemap/`og:url`/canonical fall back to `http://localhost:3000` and Next only
  prints a warning (apps/web-next/lib/site.ts).
- `API_INTERNAL_URL` (apps/web-next) → stays `http://127.0.0.1:3001/api/v1`.
  Next's own `/api/v1/:path*` rewrite is still needed for the server-rendered
  pages' client components (comments, session reads); nginx answers `/api/v1`
  first for direct browser calls, so both paths are live and neither is dead
  code. `myblog.conf` says the same thing where the API location is defined.

`COOKIE_SECURE` stays `false` while this origin is plain HTTP on a bare IP; it
flips with the S8 certificate, together with `https://` in the three values above.

## Smoke test

```bash
bash infra/nginx/smoke.sh                       # default http://127.0.0.1
bash infra/nginx/smoke.sh http://60.205.178.223 # from anywhere
SMOKE_TIMEOUT=5 bash infra/nginx/smoke.sh http://127.0.0.1
```

Six checks, each printing the HTTP number it saw: `/` carries an article title
(proves Next), `/ready` carries the API's readiness envelope (proves the API and
proves nginx passes its 503 through untouched), `/api/v1/articles?limit=1` starts
with `{"data":[`, `/admin/articles` carries the SPA's root div, the hashed asset
that HTML points at resolves (the sub-path trap), and a cookie-less
`POST /api/v1/articles` is still 401 with exactly one
`Access-Control-Allow-Origin` header.

Exit codes: `0` everything that ran passed, `1` something failed, `2` something
could not be verified and nothing failed. **`2` is not a pass** — read those runs
as "the gateway was not in the path", which is the honest description when the
base URL is a bare process or nothing is listening. Treat `2` as red in CI.

## What must be checked on the box (this is not verifiable from a laptop)

`nginx -t` in this repo's checkout passes (validated with the official
`nginx:1.27-alpine` and `nginx:1.24-alpine` images, including a deliberate
missing-semicolon control to prove the test was reading this file and not the
stock config). Syntax is not behaviour. On the deploy box:

1. `sudo nginx -t` with the real Debian `nginx.conf` and the real
   `sites-enabled` include order, then `sudo systemctl reload nginx`.
2. `bash infra/nginx/smoke.sh http://127.0.0.1` — expect six real results, not
   `cannot verify`.
3. Open `/admin/articles` in a browser and check the Network panel: the document
   is 200 AND `/assets/index-<hash>.js` is 200 with a JavaScript content-type.
   A 200 document with a 404 asset is a blank page, and `curl` alone will not
   show it.
4. Log in through GitHub once. This config does not touch the callback, but the
   gateway is where a wrong `PORTAL_WEB_ORIGIN` becomes visible.
5. `curl -s -o /dev/null -w '%{size_download}\n' -X POST -H 'content-type: application/json' --data @big.json http://127.0.0.1/api/v1/articles/import` with a
   ~9 MB body: expect the API's JSON 413 (`PAYLOAD_TOO_LARGE`), not nginx's HTML
   413. If nginx answers, `client_max_body_size` got edited.
6. Stop the API (`systemctl stop` / kill) and confirm `/` still serves (Next is
   up) while `/api/v1/...` answers the gateway's own JSON 502, and that
   `/var/log/nginx/myblog.access.log` shows `ust=` / `ua=` for it.
7. Check what Next itself sends for `/_next/static/` (`curl -I`) — the config
   hides-and-replaces `Cache-Control` there, so exactly one such header should
   come back.

## Known gaps, recorded rather than papered over

- **Media is not fronted.** Uploads presign against `MEDIA_ENDPOINT` and the
  browser PUTs to that host directly; the signature covers `Host`, so proxying
  the bucket changes the signed host and breaks every upload (SPIKE-E measured
  this class of failure). `:9000` stays publicly reachable by design.
- **`X-Forwarded-For` is a contract between these two files.** `myblog.conf` sends
  `$proxy_add_x_forwarded_for` and `apps/api` (S6 work landed 2026-10-08) sets
  `trustProxy: 'loopback'`, so the API reads the client address only from a peer
  that is already loopback — this gateway. Drop that header and every visitor
  collapses into one rate-limit bucket, which is what the anonymous OAuth `start`
  route counts on. Nothing to fix; a line to keep.
- **`/admin` costs two locations** (`/admin/` for the HTML, `/assets/` for the
  bundle) because the SPA is built with Vite's default `base: '/'`. One line in
  `apps/web/vite.config.ts` (`base: '/admin/'` for builds) collapses it to one
  location; that change is deliberately not made here, and `myblog.conf` explains
  what to delete when it is. Do not add a router `basename` along with it — the
  route table already carries `/admin`.
- **No TLS, so the session cookie crosses the public internet in cleartext.**
  Accepted for S5 (bare IP, no certificate obtainable); S8 with a domain.
