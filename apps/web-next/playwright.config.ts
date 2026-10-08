import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

/**
 * Playwright harness for `apps/web-next`'s three end-to-end tests (stage S4-e).
 *
 * What these tests are about: the public pages must put their content **in the bytes
 * the server writes**, because that is all a crawler or a link-preview bot ever sees.
 * That claim is only testable against a production server — `next dev` renders the same
 * components but is not the artifact anyone deploys — so this config starts
 * `next start` over the output of `next build`, and starts the portal API next to it.
 * Nothing here talks to the Vite SPA, and nothing here writes data.
 *
 * Three rules this file is written to hold:
 *
 * 1. **Self-sufficient.** It starts what it needs instead of asking you to remember to
 *    start something. A suite that silently passes against whatever happens to be
 *    listening is not a suite.
 * 2. **Never touches a process it did not start.** Playwright's own behaviour: with
 *    `reuseExistingServer: false` a busy port is a hard error, and the process holding
 *    it is left alone. See the two entries below for where reuse *is* allowed and why.
 * 3. **Fail loudly at config time, with instructions.** Missing build output or missing
 *    API configuration is an infrastructure gap, not a test result. It throws here —
 *    before a server is launched and before a single test runs — in the same spirit as
 *    `apps/api/src/test/articles-write.test.ts` throwing on a missing `DATABASE_URL`
 *    instead of skipping. A green run must never be possible by not having tried.
 */

/** Loopback, and it matters: `apps/api/src/server.ts` binds `127.0.0.1`, not `0.0.0.0`. */
const API_PORT = 3001
const WEB_PORT = 3000
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`

/**
 * This package is `"type": "module"`, so Playwright loads this config through the ESM
 * loader — verified, not assumed: the stack of a precondition throw below comes back
 * through `ModuleJob.run` with the file as a `file:///…` URL. `import.meta.url` is
 * therefore the reliable way to find this file's own directory.
 *
 * It matters: `apiDir` feeds existence checks, and a wrong directory would report a
 * missing `.env` or a missing build on a machine that has both.
 */
const configDir = fileURLToPath(new URL('.', import.meta.url))
const apiDir = path.resolve(configDir, '..', 'api')
const apiEnvFile = path.join(apiDir, '.env')

/**
 * Every key `loadConfig()` marks required, with no default
 * (`apps/api/src/config/index.ts`). Names only, and they stay names: this file must
 * never contain a credential value, and it must never print one.
 */
const REQUIRED_API_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'OAUTH_CLIENT_ID',
  'OAUTH_CLIENT_SECRET',
  'MEDIA_ENDPOINT',
  'MEDIA_BUCKET',
  'MEDIA_ACCESS_KEY_ID',
  'MEDIA_SECRET_ACCESS_KEY',
  'MEDIA_PUBLIC_BASE_URL',
] as const

const hasApiEnvFile = existsSync(apiEnvFile)

/**
 * The API process needs the same configuration `pnpm --filter api dev` gets from
 * `.env`. `tsx --env-file-if-exists` supplies it there; `node dist/server.js` reads no
 * `.env` by itself, so the harness passes `--env-file=.env` when the file exists.
 *
 * Why not copy the values into this file: `playwright.config.ts` is tracked, and the
 * required keys include `JWT_SECRET` and the OAuth client secret. The alternative —
 * duplicating them into CI's `env:` — is already how CI works, because CI genuinely has
 * no `.env`; those are deliberately fake values, not real ones.
 *
 * So: `.env` if we have it, otherwise the inherited environment (which is what CI
 * supplies), and neither is a licence to be silent — if both are missing, throw here.
 */
const missingApiKeys = hasApiEnvFile ? [] : REQUIRED_API_KEYS.filter((key) => !process.env[key])

if (missingApiKeys.length > 0) {
  throw new Error(
    '[web-next e2e] Cannot start the portal API: none of these required variables is available —\n' +
      `  ${missingApiKeys.join(', ')}\n` +
    'Either copy `apps/api/.env.example` to `apps/api/.env` and fill in the values ' +
    '(that file is git-ignored, so a fresh clone has none), or export them in the shell ' +
    'that runs `test:e2e`. The suite will not skip past this: an e2e run that never ' +
    'started the API would prove nothing about the pages it is meant to read.\n' +
    'See apps/api/src/config/index.ts for what each key is for.',
  )
}

/**
 * The two artifacts `next start` and `node dist/server.js` serve. Checked rather than
 * built: the builds belong to `pnpm -r build` (and to CI's `Build` step), and a harness
 * that rebuilds silently would hide a broken build step behind a green test run.
 *
 * `required-server-files.json` is the marker for the Next output rather than
 * `.next/BUILD_ID`, because `next dev` writes `.next/` too and is not a testable
 * artifact for these three tests.
 */
const missingArtifacts = [
  [path.join(apiDir, 'dist', 'server.js'), 'apps/api/dist/server.js'],
  [path.join(configDir, '.next', 'required-server-files.json'), 'apps/web-next/.next/ (next build)'],
]
  .filter(([absolute]) => !existsSync(absolute))
  .map(([, label]) => label)

if (missingArtifacts.length > 0) {
  throw new Error(
    '[web-next e2e] These tests run against built output, and the build output is missing —\n' +
      missingArtifacts.map((label) => `  - ${label}`).join('\n') +
      '\nBuild first: `pnpm -r build` (locally on this repo today: `corepack pnpm@12.4.1 -r build`). ' +
      'CI does this in its Build step, which is why the e2e step runs after it.',
  )
}

export default defineConfig({
  testDir: './e2e',
  /**
   * One worker, no retries, serial.
   *
   * Both servers hold the *real* seeded database, and `/` plus `/blog/[slug]` answer
   * from an ISR cache that regenerates in the background. Parallel workers or retries
   * would race that cache and turn a deterministic claim into a coin flip.
   */
  fullyParallel: false,
  workers: 1,
  retries: 0,
  /** The warm-up poll in test 1 can legitimately need tens of seconds after a cold build. */
  timeout: 90_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI
    ? [['github'], ['list']]
    : [['list'], ['html', { open: 'never' }]],
  outputDir: './test-results',
  use: {
    /**
     * `127.0.0.1`, not `localhost`: on Windows `localhost` resolves `::1` first, and
     * `next start -H 127.0.0.1` listens on IPv4 only — the request would be refused
     * for a reason that has nothing to do with the app.
     */
    baseURL: WEB_ORIGIN,
  },
  webServer: [
    {
      /**
       * The portal API — the origin the pages read their content from.
       *
       * Started first and waited for: `/` is prerendered at build time, but every page
       * here reads the API at request time, and a test that ran against a half-booted
       * API would fail on the *degraded* rendering path rather than on the thing under
       * test. `/health` is the liveness route that checks nothing, so it answers as soon
       * as the process is listening (design D-3's degraded path is why a slow dependency
       * must never be able to look like a passing page).
       */
      name: 'api',
      command: hasApiEnvFile
        ? 'node --env-file=.env dist/server.js'
        : 'node dist/server.js',
      /** Relative to this config's directory — Playwright resolves it against configDir. */
      cwd: '../api',
      url: `${API_ORIGIN}/health`,
      env: {
        /**
         * Pinned so the readiness URL cannot disagree with what binds.
         *
         * Measured on Node 22 (`node --env-file`): a variable the parent already set is
         * **not** overridden by the `.env` file. So this wins over a stray `PORT=` in a
         * developer's `.env`, in both the `--env-file` and the inherited-env branch.
         */
        PORT: String(API_PORT),
      },
      /**
       * Reuse locally, never in CI.
       *
       * Locally a developer very often already has `pnpm --filter api dev` running
       * against the same database, and Playwright must not kill a process it did not
       * start. The API is not the artifact under test here — the Next server's HTML is —
       * so serving the tests from that already-running API is honest. In CI nothing is
       * running, so the harness always starts its own.
       */
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      /** pino writes JSON logs to stdout; a green run should not have to read them. */
      stdout: 'ignore',
      /** Startup failures (ConfigError, EADDRINUSE) go to stderr and must be visible. */
      stderr: 'pipe',
    },
    {
      /**
       * `next start` over the production build.
       *
       * `node node_modules/next/dist/bin/next start ...` rather than
       * `pnpm --filter web-next start`: the harness should not need a package manager to
       * run a server, and on this machine `pnpm` on PATH is broken (it has to be
       * `corepack pnpm@12.4.1`), which does not hold for CI. Same `next start`, same
       * flags as the package's own `start` script — **if that script's port or bind
       * address changes, change them here too.**
       */
      name: 'web-next',
      command: `node node_modules/next/dist/bin/next start -H 127.0.0.1 -p ${WEB_PORT}`,
      url: `${WEB_ORIGIN}/icon.svg`,
      /**
       * Never reused — the one place this file departs from the local-dev default.
       *
       * A leftover `next dev` on 3000 would answer every request, and the suite would
       * be green while testing something other than the built artifact. That is a
       * silent weakening of exactly the claim these three tests exist to make, so a
       * busy port is an error instead:
       * "http://127.0.0.1:3000/icon.svg is already used, make sure that nothing is
       * running on the port/url". Playwright does not kill whatever is holding it.
       */
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
})
