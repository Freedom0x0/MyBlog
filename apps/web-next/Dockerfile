# syntax=docker/dockerfile:1
#
# The public-site image (Next.js App Router, standalone output).
#
# `NEXT_OUTPUT=standalone` is the build-time switch explained in next.config.ts. It
# matters here for one concrete reason: without standalone, this stage would have to
# copy Next's dev-time node_modules closure to run `next start`, and the runtime image
# becomes several hundred MB of toolchain that no request ever needs. With it, the
# server is `server.js` plus a `node_modules` of the actual runtime deps.

FROM node:22-alpine AS build

RUN corepack enable

WORKDIR /app

# See apps/api/Dockerfile: same reason (the registry is slow-to-unreachable from this
# region), same non-effect on the artifact. This install also spends its time on
# pnpm's supply-chain verification, which fetches publish metadata for every lockfile
# entry including Windows-only optional binaries; a regional mirror is the difference
# between a 15-minute failure and a working build.
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV npm_config_registry=${NPM_REGISTRY}

COPY tsconfig.base.json ./

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web-next/package.json apps/web-next/

RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/web-next apps/web-next

# The build must not need the portal API (design D-3): CI has no api process, and the
# deploy box may start these out of order. lib/api.ts degrades to an explicit
# "interface unreachable" state instead of throwing, so the artifact is always
# produced. The consequence is written there and in the e2e warm-up: a homepage
# prerendered while the API was down serves the degraded copy until the first
# revalidation, which is why the prod compose waits on /ready before starting this.
RUN NEXT_OUTPUT=standalone pnpm --filter shared build \
 && pnpm --filter web-next build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --chown=node:node --from=build /app/apps/web-next/.next/standalone ./
COPY --chown=node:node --from=build /app/apps/web-next/.next/static ./apps/web-next/.next/static

USER node

# HOSTNAME is not decoration and its default is the wrong value: the standalone server
# binds 0.0.0.0 unless told otherwise, which on a host-network container means every
# interface of the machine. Loopback here, same rule as apps/api's hardcoded bind, and
# nginx reaches it over the same host network namespace.
ENV HOSTNAME=127.0.0.1 \
    PORT=3000

EXPOSE 3000

CMD ["node", "apps/web-next/server.js"]
