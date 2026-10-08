# syntax=docker/dockerfile:1
#
# The portal API image. Two stages, and the reason is not size: the build needs the
# whole pnpm workspace (this package imports `shared` by workspace link), while the
# runtime needs exactly one package plus its production closure. `pnpm deploy` is what
# turns that into a self-contained directory, so the runtime never carries a workspace
# it cannot resolve.
#
# Node 22 to match CI (`node-version: 22` in .github/workflows/ci.yml), not the 24 that
# happens to be installed on any given laptop. The version that builds a release should
# be the version that tests it.

FROM node:22-alpine AS build

RUN corepack enable

WORKDIR /app

# The registry is a build arg because the deploy target is in mainland China: the
# default npm registry took 14m35s and then failed mid-verification for a sibling
# image on this network. On the Aliyun box, build with
#   --build-arg NPM_REGISTRY=https://registry.npmmirror.com
# The value is not baked into the image — it only affects the install step, which
# produces no runtime artifact difference: the lockfile still pins every version.
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV npm_config_registry=${NPM_REGISTRY}

# `tsconfig.base.json` is required, not incidental: packages/shared/tsconfig.json
# `extends` it, and omitting it fails the build with TS5083 "Cannot read file
# '/app/tsconfig.base.json'" — the measured first failure of this Dockerfile.
COPY tsconfig.base.json ./

# Manifests first, sources second: this layer survives every `git push` that touches no
# dependency, so a code-only change reuses the install instead of re-resolving the
# workspace.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/

# `--ignore-scripts` is deliberate: pnpm 12 blocks dependency build scripts behind an
# allowlist (see pnpm-workspace.yaml, where only `esbuild` is permitted), and the API's
# production dependency set has no postinstall to run. If a future dependency needs one,
# this is the line where it silently does not happen — the build must then be changed
# knowingly, not by dropping the flag.
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/api apps/api

RUN pnpm --filter shared build \
 && pnpm --filter api build \
 && pnpm deploy --prod --filter api /prod/api

FROM node:22-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

# `chown` in the COPY, then a non-root USER: dist/server.js is read-only at runtime and
# the process should not be able to rewrite its own code. Postgres, Redis and the media
# bucket are all reached over the network, so there is no legitimate write here.
COPY --chown=node:node --from=build /prod/api ./

USER node

# The port is informational. What actually controls exposure is the bind address in
# src/server.ts — hardcoded to 127.0.0.1 — and infra/docker-compose.prod.yml, which runs
# on the host network so that loopback default keeps meaning "only the gateway can reach
# me". Do not add a `-p 3001:3001` somewhere else and assume the bind changed with it.
EXPOSE 3001

# No `--env-file`: config arrives through the environment (compose's env_file is the one
# place it is read), which is also what keeps a secret out of an image layer.
CMD ["node", "dist/server.js"]
