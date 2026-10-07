#!/usr/bin/env bash
# =============================================================================
# smoke.sh — prove the S5 gateway ROUTES, through the gateway.
#
#   usage: ./smoke.sh [BASE_URL]         default BASE_URL = http://127.0.0.1
#          ./smoke.sh http://60.205.178.223
#          ./smoke.sh http://127.0.0.1:3001     # no gateway: see the verdict note
#
# Every request here goes to the ONE origin a visitor uses. That is the point:
# probing 127.0.0.1:3000 and :3001 directly would prove the processes work and
# say nothing about the only thing this stage adds, which is the routing.
#
# Exit codes, and why "nothing was proven" is not 0:
#   0  every check that ran passed
#   1  at least one check FAILED
#   2  at least one check could not be verified and none failed
# 2 is deliberately not 0: a CI gate that goes green because the gateway was not
# running would be worse than no gate at all. If you want strictness, treat 2 as
# red too.
#
# CANNOT VERIFY vs FAIL is the distinction this script exists to get right. A
# check reports CANNOT VERIFY only when the thing it tests is not being exercised
# at all — nothing answering at $BASE, or a single process answering where the
# gateway should be. A wrong number, or the right number with the wrong body, is
# a FAIL. Both print the number that was actually seen.
# =============================================================================

set -u # NOT set -e: one failing check must not stop the other four from running
       # and printing their numbers — a smoke test that aborts at the first
       # surprise reports one symptom where it was asked for five.

BASE="${1:-http://127.0.0.1}"
BASE="${BASE%/}"                    # a trailing slash would produce `//api/v1`
TIMEOUT="${SMOKE_TIMEOUT:-15}"

if ! command -v curl >/dev/null 2>&1; then
  printf 'curl is not on PATH; nothing here can be checked.\n' >&2
  exit 2
fi

TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

BODY="$TMPD/body"
HDR="$TMPD/hdr"
RQ_RC=0
RQ_STATUS=000

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

# request METHOD URL [curl-args...]
# Fills RQ_STATUS (HTTP code, or 000 when no HTTP response was received) and
# RQ_RC (curl's own exit status: 7 refused, 28 timed out, 6 bad DNS...). Both
# matter: a 000 with rc=7 means "nothing is listening", which is not the same
# finding as "something answered 500".
# Optional curl args go through `"$@"` after the two shifts rather than a
# `"${extra[@]}"` array: expanding an empty array under `set -u` is an error on
# bash 4.2, which is still what some deploy boxes ship.
request() {
  local method="$1" url="$2"
  shift 2
  local code
  # Truncate first, every time. curl leaves the output files alone when the
  # connection never came up, and without this the next check would be reading
  # the PREVIOUS response — a stale body that happens to contain `"status":`
  # would turn into a PASS that describes a request that never happened.
  : >"$BODY"
  : >"$HDR"
  code="$(curl -s -o "$BODY" -D "$HDR" -w '%{http_code}' -X "$method" \
              --max-time "$TIMEOUT" "$@" "$url" 2>/dev/null)"
  RQ_RC=$?
  RQ_STATUS="${code:-000}"
  # curl writes header lines with CRLF whatever the platform; strip it once so
  # every `grep '^access-control-...'` below behaves the same on Linux and on
  # Git Bash.
  tr -d '\r' <"$HDR" >"$HDR.c" && mv "$HDR.c" "$HDR"
}

hdr_of() { grep -i "^$1:" "$HDR" | sed -e "s/^[^:]*: *//" -e 's/[[:space:]]*$//'; }

count_hdr() { grep -ci "^$1:" "$HDR"; }

PASS_N=0; FAIL_N=0; SKIP_N=0
pass() { printf 'PASS           %-26s %s\n' "$1" "$2"; PASS_N=$((PASS_N + 1)); }
fail() { printf 'FAIL           %-26s %s\n' "$1" "$2"; FAIL_N=$((FAIL_N + 1)); }
cannot() {
  printf 'CANNOT VERIFY  %-26s %s\n' "$1" "$2"
  SKIP_N=$((SKIP_N + 1))
}

# snippet FILE [BYTES] — a one-line, whitespace-collapsed excerpt for failure
# messages. The reader needs to see WHAT ANSWERED; a raw HTML body would push six
# lines of doctype into the middle of a five-line report and hide the point.
snippet() {
  [ -f "$1" ] || { printf '(no body captured)'; return; }
  head -c "${2:-120}" "$1" | tr '\r\n\t' '   ' | tr -s ' '
}

# curl_reason RC — the handful of curl exit codes that mean different outages.
# "connection refused" is `nothing is listening here`, "timed out" is something
# eating requests, and "couldn't resolve host" is a typo in the base URL: the
# operator reading the line should not have to know curl's numbering to tell them
# apart, and all three are CANNOT VERIFY rather than FAIL.
curl_reason() {
  case "$1" in
    6)  printf 'could not resolve the host' ;;
    7)  printf 'connection refused — nothing listening' ;;
    28) printf 'timed out after %ss' "$TIMEOUT" ;;
    35|60) printf 'TLS/proxy problem (this gateway listens on plain :80)' ;;
    52) printf 'empty reply from server' ;;
    *)  printf 'curl exit %s' "$1" ;;
  esac
}

# HTML-escape a needle the way a server component does before writing it into
# markup. The project's own e2e helper makes the same transformation
# (`htmlText`, apps/web-next/e2e/server-html.ts) for the same reason: a title
# containing `&` is written as `&amp;`, so searching the raw string in the bytes
# would report a missing title that is plainly on the page.
html_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# ---------------------------------------------------------------------------
# verdict 0: is there a gateway at $BASE at all, and if not, what is there?
#
# Two signals, either one is enough:
#   1. `Server: nginx`. infra/nginx/myblog.conf sets `server_tokens off`, which
#      trims the VERSION but keeps the header — if someone clears the header
#      entirely, this signal goes and signal 2 has to carry it.
#   2. structurally: `/` answering Next's HTML *and* `/api/v1/...` answering the
#      API's JSON from one origin. No single process can do both, so that is a
#      gateway even without a Server header.
# This decides which checks may report FAIL and which must report CANNOT VERIFY:
# the two routing checks that only the gateway can answer (`/` -> Next,
# `/admin/...` -> the SPA) are not failures when there is no gateway in front —
# they are simply not being tested, and calling them failures sends the next
# reader to debug a config that was never in the path.
# ---------------------------------------------------------------------------
GATEWAY=0
RESPONDING=''
ROOT_FAILED=0

request GET "$BASE/"
ROOT_STATUS=$RQ_STATUS
ROOT_RQ_RC=$RQ_RC
cp "$BODY" "$TMPD/root" 2>/dev/null || :
ROOT_HDR="$TMPD/root.hdr"
cp "$HDR" "$ROOT_HDR"

if [ "$ROOT_RQ_RC" -ne 0 ]; then
  # The probe never got an HTTP response. Read that as a statement about THIS
  # request, not about the whole run: a process restarting mid-run (a `tsx
  # watch` reload, measured on this machine while writing this script) can leave
  # `GET /` refused while the requests after it answer fine. So every check still
  # judges its OWN request, and the coherence note at the bottom says out loud
  # when the picture does not hang together. The wording here used to be "nothing
  # answering, so nothing below can be verified" — printed directly above a PASS.
  # That is the one lie a smoke script must not tell.
  ROOT_FAILED=1
else
  if grep -qi '^server: *nginx' "$ROOT_HDR"; then
    GATEWAY=1
    RESPONDING='nginx (Server header)'
  fi
fi

# ---------------------------------------------------------------------------
# check 3 first, because it feeds check 1's needle
#   GET /api/v1/articles?limit=1 -> 200 + `{"data":[`
# ---------------------------------------------------------------------------
request GET "$BASE/api/v1/articles?limit=1"
ART_STATUS=$RQ_STATUS
ART_RC=$RQ_RC
cp "$BODY" "$TMPD/articles" 2>/dev/null || :

# Second signal for the gateway verdict: two different answer shapes, one origin.
if [ "$GATEWAY" -eq 0 ] \
   && [ "$ROOT_STATUS" = "200" ] && grep -q '_next/' "$TMPD/root" 2>/dev/null \
   && [ "$ART_STATUS" = "200" ] && grep -q '"data":\[' "$TMPD/articles" 2>/dev/null; then
  GATEWAY=1
  RESPONDING='two different upstreams behind one origin (Next HTML on /, API JSON on /api/v1)'
fi

# What IS answering, for the CANNOT VERIFY messages.
if [ "$ROOT_FAILED" -eq 0 ] && [ "$GATEWAY" -eq 0 ]; then
  if grep -q '"code":"NOT_FOUND"' "$TMPD/root" 2>/dev/null; then
    RESPONDING="the Fastify API directly ($ROOT_STATUS on GET /, its own NOT_FOUND envelope)"
  elif grep -q '_next/' "$TMPD/root" 2>/dev/null; then
    RESPONDING='Next.js directly (no gateway in front of it)'
  elif grep -q 'id="root"' "$TMPD/root" 2>/dev/null; then
    RESPONDING='the Vite SPA directly (no gateway in front of it)'
  else
    RESPONDING="something that is not this gateway (GET / -> $ROOT_STATUS)"
  fi
fi

printf 'base        %s\n' "$BASE"
if [ "$ROOT_RQ_RC" -ne 0 ]; then
  printf 'probe       GET %s/ -> no HTTP response (curl exit %s: %s)\n' \
    "$BASE" "$ROOT_RQ_RC" "$(curl_reason "$ROOT_RQ_RC")"
else
  printf 'probe       GET %s/ -> HTTP %s\n' "$BASE" "$ROOT_STATUS"
fi
if [ "$GATEWAY" -eq 1 ]; then
  printf 'in front?   yes: %s\n' "$RESPONDING"
elif [ "$ROOT_FAILED" -eq 1 ]; then
  printf 'in front?   no evidence of one — the probe request never got an HTTP response\n'
else
  printf 'in front?   NO — %s\n' "$RESPONDING"
fi
printf -- '----\n'

no_gateway_reason() {
  if [ "$ROOT_FAILED" -eq 1 ]; then
    printf 'GET %s/ never answered (curl exit %s: %s), so nothing in this run was routed by nginx' \
      "$BASE" "$ROOT_RQ_RC" "$(curl_reason "$ROOT_RQ_RC")"
  else
    printf 'no gateway in front of %s: %s. This path is decided by nginx routing, which is not being exercised here.' "$BASE" "$RESPONDING"
  fi
}

# ---- check 1: GET / -> 200, and an article TITLE in the bytes Next writes ---
NEEDLE=''
NEEDLE_SKIP=''
# First title in the API's default order. `[^"\\]*` refuses a needle containing a
# quote-escape: a title with `\"` in the JSON would otherwise be truncated to
# half a string, and a truncated needle produces a FAIL that means nothing.
NEEDLE="$(grep -o '"title":"[^"\\]*"' "$TMPD/articles" 2>/dev/null | head -n1 \
          | sed -e 's/^"title":"//' -e 's/"$//')"
if [ -n "$NEEDLE" ] && [ "${#NEEDLE}" -lt 2 ]; then NEEDLE=''; fi
if [ -z "$NEEDLE" ] && [ "$ART_STATUS" = "200" ]; then
  NEEDLE_SKIP='the API returned 200 but no usable title on the first page (no published articles, or the only title contains an escape sequence)'
fi

if [ "$GATEWAY" -ne 1 ]; then
  cannot 'GET /' "$(no_gateway_reason)"
else
  request GET "$BASE/"
  if [ "$RQ_RC" -ne 0 ]; then
    fail 'GET /' "curl exit $RQ_RC — $(curl_reason "$RQ_RC"). A gateway was detected from the probe, but this request never completed: that is a routing fault, not an absent process."
  elif [ "$RQ_STATUS" != "200" ]; then
    fail 'GET /' "HTTP $RQ_STATUS (expected 200)"
  elif grep -q 'id="root"' "$BODY" && ! grep -q '_next/' "$BODY"; then
    fail 'GET /' "HTTP $RQ_STATUS but the Vite SPA answered: it has <div id=\"root\"> and no /_next/ assets. \`location /\` is pointing at the SPA, not at Next."
  elif ! grep -q '_next/' "$BODY"; then
    fail 'GET /' "HTTP $RQ_STATUS and nothing under /_next/ in the body — not Next's document, whatever it is"
  elif [ -n "$NEEDLE_SKIP" ]; then
    cannot 'GET /' "HTTP $RQ_STATUS from Next, but $NEEDLE_SKIP — there is no title to look for, so the page cannot be shown to carry content"
  else
    ESCAPED="$(html_escape "$NEEDLE")"
    if grep -qF -- "$NEEDLE" "$BODY" || grep -qF -- "$ESCAPED" "$BODY"; then
      pass 'GET /' "HTTP $RQ_STATUS, Next's markup (/_next/) carries the newest article title: ${NEEDLE:0:40}"
    elif grep -q '暂时拉不到文章列表' "$BODY"; then
      fail 'GET /' "HTTP $RQ_STATUS from Next, but it says the article list is unreachable — Next could not reach the API server-side (API_INTERNAL_URL), so the title check is moot"
    elif grep -q '这里还没有文章' "$BODY"; then
      fail 'GET /' "HTTP $RQ_STATUS from Next in its empty state (「这里还没有文章」) while the API returned a title — $NEEDLE"
    else
      fail 'GET /' "HTTP $RQ_STATUS from Next, but the title is not in the bytes: ${NEEDLE:0:40}. Within the 60s ISR window (app/page.tsx `revalidate = 60`) the homepage can be one publish behind the API — re-run before believing this."
    fi
  fi
fi

# ---- check 2: GET /ready -> 200 or 503, with the API's JSON envelope ---------
# An API-path check: it judges its OWN request instead of inheriting the probe's
# verdict, so it still means something when $BASE is the API with no gateway in
# front of it — which is exactly how this script was exercised on a dev box.
request GET "$BASE/ready"
CT="$(hdr_of content-type)"
READINESS="$(grep -o '"checks":{[^}]*}' "$BODY" | head -n1)"
if [ "$RQ_RC" -ne 0 ]; then
  cannot 'GET /ready' "curl exit $RQ_RC — $(curl_reason "$RQ_RC"); nothing answered this request"
elif [ "$RQ_STATUS" = "404" ] && grep -q '"code":"NOT_FOUND"' "$BODY"; then
  # Only reachable when there IS a gateway and /ready is not routed to the API,
  # or when the base is the API itself. Say which.
  if [ "$GATEWAY" -eq 1 ]; then
    fail 'GET /ready' "HTTP 404 with the API's envelope — the gateway reached the API but not this path; \`location = /ready\` is missing or shadowed"
  else
    cannot 'GET /ready' "$(no_gateway_reason)"
  fi
elif [ "$RQ_STATUS" = "200" ] || [ "$RQ_STATUS" = "503" ]; then
  if printf '%s' "$CT" | grep -qi 'application/json' && grep -q '"status":' "$BODY" \
     && grep -q '"checks":' "$BODY"; then
    if [ "$RQ_STATUS" = "200" ]; then
      pass 'GET /ready' "HTTP 200, API envelope: $READINESS"
    else
      # 503 here is the API's OWN answer, not a gateway fault: the gateway
      # passed it through untouched, which is exactly what `proxy_intercept_errors
      # off` in myblog.conf is there to guarantee.
      pass 'GET /ready' "HTTP 503 from the API itself (postgres or redis down), envelope passed through intact: $READINESS"
    fi
  else
    fail 'GET /ready' "HTTP $RQ_STATUS but not the API's readiness envelope (content-type: ${CT:-none}); body was: $(snippet "$BODY" 120)"
  fi
elif [ "$RQ_STATUS" = "502" ] || [ "$RQ_STATUS" = "504" ]; then
  if grep -q 'GATEWAY_UPSTREAM_UNAVAILABLE' "$BODY"; then
    fail 'GET /ready' "HTTP $RQ_STATUS from the gateway's own @api_down body — the API process is not reachable from nginx (is it running on 127.0.0.1:3001?)"
  else
    fail 'GET /ready' "HTTP $RQ_STATUS with a non-JSON body ($(snippet "$BODY" 80))"
  fi
else
  fail 'GET /ready' "HTTP $RQ_STATUS (expected 200 or 503), content-type ${CT:-none}"
fi

# ---- check 3: GET /api/v1/articles?limit=1 -> 200 + `{"data":[` --------------
# What this proves, stated exactly: the gateway delivers this path to something
# that answers with the API's list contract. What it CANNOT prove, because it is
# not observable from outside: whether nginx went straight to the API or handed
# the request to Next and Next's `/api/v1/:path*` rewrite carried it the rest of
# the way (`poweredByHeader: false` in next.config.ts, and both routes emit the
# same bytes). The failure this catches is the one that matters at the gateway —
# a Next 404 HTML page where the API's JSON should be, i.e. `location /api/v1`
# missing or shadowed.
if [ "$ART_RC" -ne 0 ]; then
  cannot 'GET /api/v1/articles' "curl exit $ART_RC — $(curl_reason "$ART_RC")"
elif [ "$ART_STATUS" = "200" ] && grep -q '{"data":\[' "$TMPD/articles"; then
  pass 'GET /api/v1/articles?limit=1' "HTTP 200, body begins $(snippet "$TMPD/articles" 9) — the API path is not being eaten by Next"
elif [ "$ART_STATUS" = "200" ]; then
  fail 'GET /api/v1/articles?limit=1' "HTTP 200 but the body does not start with {\"data\":[ : $(snippet "$TMPD/articles" 120)"
else
  fail 'GET /api/v1/articles?limit=1' "HTTP $ART_STATUS, body: $(snippet "$TMPD/articles" 120)"
fi

# ---- check 4: GET /admin/articles -> 200 + the SPA's root div ---------------
if [ "$GATEWAY" -ne 1 ]; then
  cannot 'GET /admin/articles' "$(no_gateway_reason)"
else
  request GET "$BASE/admin/articles"
  SPA_ASSET=''
  if [ "$RQ_RC" -ne 0 ]; then
    cannot 'GET /admin/articles' "curl exit $RQ_RC — $(curl_reason "$RQ_RC")"
  elif [ "$RQ_STATUS" != "200" ]; then
    fail 'GET /admin/articles' "HTTP $RQ_STATUS (expected 200 from the SPA fallback)"
  elif ! grep -q 'id="root"' "$BODY"; then
    if grep -q '_next/' "$BODY"; then
      fail 'GET /admin/articles' "HTTP 200 but Next answered it (/_next/ present, no SPA root div) — \`location /admin/\` is not matching, or the SPA fallback is not configured"
    else
      fail 'GET /admin/articles' "HTTP 200 with no <div id=\"root\"> — $(snippet "$BODY" 100)"
    fi
  else
    pass 'GET /admin/articles' "HTTP 200 with the SPA's root div — the deep-link fallback to /admin/index.html works"
    SPA_ASSET="$(grep -o '/assets/index-[^\"]*\.js' "$BODY" | head -n1)"
  fi

  # ---- check 5: the asset that HTML points at must resolve ----------------
  # The sub-path trap in one request. `base: '/'` bakes ROOT-absolute asset URLs
  # into index.html, so `/admin/articles` answering 200 with the root div proves
  # only the half that nginx does: the browser's next request is for `/assets/...`
  # at the origin root, and if `location /assets/` is missing Next answers that
  # with a 404 page. The visible symptom is a blank admin screen; `curl
  # /admin/articles` still looks fine.
  if [ -z "${SPA_ASSET:-}" ]; then
    cannot 'GET <hashed asset>' "no /assets/index-*.js reference in the served HTML, so there is nothing to resolve (dist built with a different base, or a fallback page was served)"
  else
    request GET "$BASE$SPA_ASSET"
    ASSET_CT="$(hdr_of content-type)"
    if [ "$RQ_STATUS" = "200" ] && printf '%s' "$ASSET_CT" | grep -qi 'javascript'; then
      pass 'GET <hashed asset>' "HTTP 200 for $SPA_ASSET, content-type ${ASSET_CT} — the root-absolute URL baked by \`base: /\` resolves"
    elif [ "$RQ_STATUS" = "200" ]; then
      fail 'GET <hashed asset>' "HTTP 200 for $SPA_ASSET but content-type is ${ASSET_CT:-none} — the browser refuses a module that is not served as JavaScript (check mime.types)"
    else
      fail 'GET <hashed asset>' "HTTP $RQ_STATUS for $SPA_ASSET — the SPA would load its HTML and then show nothing"
    fi
  fi
fi

# ---- check 6: POST /api/v1/articles with no cookie -> 401 -------------------
# Two assertions in one request, because the two things that can go wrong here
# go wrong together: (a) a gateway that silently authenticates or strips the
# cookie turns an unauthenticated write into a real one, and (b) a gateway that
# adds `Access-Control-Allow-*` starts a second, wider auth surface next to the
# one the API configures deliberately (apps/api allows exactly one origin,
# PORTAL_WEB_ORIGIN, with credentials: true).
#
# The CORS half has to be phrased carefully, and the reason was measured rather
# than assumed: apps/api emits `access-control-allow-origin` on EVERY response —
# including 401s and even 404s — whether or not the request carried an `Origin`.
# So "no CORS headers in the response" is not a gateway assertion at all; what
# is testable is that there is exactly ONE, i.e. nginx added nothing on top.
# Two `Access-Control-Allow-Origin` values is not a wider door, it is a broken
# one: browsers reject a response whose ACAO header has more than one value.
if [ "$ROOT_FAILED" -eq 1 ] && [ "$GATEWAY" -eq 0 ]; then
  # Nothing accepted the probe and no gateway signature was seen, so there is no
  # point POSTING into the dark: this request would fail for the same reason the
  # probe did, and reporting that as a check outcome would be noise.
  cannot 'POST /api/v1/articles' "$(no_gateway_reason)"
else
  request POST "$BASE/api/v1/articles" -H 'content-type: application/json' --data '{}'
  ACAO_N="$(count_hdr 'access-control-allow-origin')"
  if [ "$RQ_RC" -ne 0 ]; then
    cannot 'POST /api/v1/articles' "curl exit $RQ_RC — $(curl_reason "$RQ_RC"); nothing answered this request"
  elif [ "$RQ_STATUS" = "401" ] && grep -q '"code":"UNAUTHORIZED"' "$BODY"; then
    if [ "${ACAO_N:-0}" -le 1 ]; then
      pass 'POST /api/v1/articles' "HTTP 401 + the API's error envelope ($(snippet "$BODY" 90)), ${ACAO_N:-0} access-control-allow-origin header(s) — the gateway added none"
    else
      fail 'POST /api/v1/articles' "HTTP 401 as expected, but $ACAO_N access-control-allow-origin headers — the gateway is duplicating CORS, which browsers read as an invalid response"
    fi
  elif [ "$RQ_STATUS" = "403" ] && grep -q 'CSRF_CHECK_FAILED' "$BODY"; then
    fail 'POST /api/v1/articles' "HTTP 403 CSRF_CHECK_FAILED — the CSRF gate answered BEFORE the auth gate, which means a session was accepted; this request sent no cookie"
  elif [ "$RQ_STATUS" = "404" ]; then
    if [ "$GATEWAY" -eq 1 ]; then
      fail 'POST /api/v1/articles' "HTTP 404 through the gateway — \`location /api/v1\` is not delivering writes to the API"
    else
      cannot 'POST /api/v1/articles' "$(no_gateway_reason)"
    fi
  elif [ "$RQ_STATUS" = "201" ] || [ "$RQ_STATUS" = "200" ]; then
    # Say what the bytes are before saying what they mean. A 200 here with the
    # API's JSON is a real unauthenticated write; a 200 carrying an HTML page is
    # a static server's SPA fallback answering a POST, which is a different bug
    # wearing the same status code — and the fix is in a different file.
    if printf '%s' "$(hdr_of content-type)" | grep -qi 'application/json'; then
      fail 'POST /api/v1/articles' "HTTP $RQ_STATUS with a JSON body — an article was created with NO cookie. That is not a smoke-test nuisance, it is an unauthenticated write: $(snippet "$BODY" 100)"
    else
      fail 'POST /api/v1/articles' "HTTP $RQ_STATUS with a non-JSON body — the write never reached the API (this is a fallback/static answer on the write path): $(snippet "$BODY" 100)"
    fi
  else
    fail 'POST /api/v1/articles' "HTTP $RQ_STATUS, expected 401; body: $(snippet "$BODY" 120)"
  fi
fi

# ---------------------------------------------------------------------------
# Coherence note. The probe and the checks are separate requests, so a process
# restarting mid-run produces a report that says "GET / never answered" and then
# prints a PASS further down — measured on this machine while this file was being
# written (`tsx watch` reloaded the API between two requests). Say that out loud
# instead of leaving the reader to spot the contradiction, and do not quietly
# soften it into a clean verdict.
if [ "$ROOT_FAILED" -eq 1 ] && [ $((PASS_N + FAIL_N)) -gt 0 ]; then
  printf -- '----\n'
  printf 'NOTE: GET %s/ never answered, yet %s check(s) did get an HTTP response.\n' \
    "$BASE" "$((PASS_N + FAIL_N))"
  printf '      Something answers some paths and not the others: most likely an app process\n'
  printf '      restarted mid-run, or this base URL is a bare process rather than the\n'
  printf '      gateway. Re-run this script before concluding anything from the lines above.\n'
fi

printf -- '----\n'
printf 'pass %s   fail %s   cannot-verify %s\n' "$PASS_N" "$FAIL_N" "$SKIP_N"
if [ "$FAIL_N" -gt 0 ]; then
  printf 'RESULT: FAILED\n'
  exit 1
elif [ "$SKIP_N" -gt 0 ]; then
  printf 'RESULT: NOT VERIFIED — %s check(s) had no gateway to exercise. This is not a pass.\n' "$SKIP_N"
  exit 2
else
  printf 'RESULT: all checks passed\n'
  exit 0
fi
