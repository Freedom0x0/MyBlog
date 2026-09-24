# Backend Conventions

> Config, errors, health checks, testing, and dependencies.

---

## 1. Config: validate at boot, fail loudly

Environment variables are parsed **once, at startup**, by a Zod schema in
`src/config/index.ts`. Nothing reads `process.env` anywhere else.

Three rules:

- **Required values have no default.** A missing `DATABASE_URL` must stop the
  process, not surface as a 500 on some request an hour later.
- **Report every problem at once.** Fixing one missing variable per restart is a
  miserable loop; `error.issues` already contains all of them.
- **Throw, don't exit.** `loadConfig` throws `ConfigError`; `server.ts` decides
  that a bad config means `process.exit(1)`. Exiting from inside a function makes
  it untestable and hides control flow.

```ts
const config = loadConfig()   // throws ConfigError listing every bad variable
```

---

## 2. Error contract

Every error response, including 404s, uses one shape:

```json
{ "error": { "code": "NOT_FOUND", "message": "...", "requestId": "..." } }
```

The three fields are deliberately separate:

| Field | Audience | Purpose |
|---|---|---|
| `code` | programs | branch on it; never parse `message` |
| `message` | humans | explain what to do |
| `requestId` | operators | find the log line that explains it |

**Routes never build error responses.** They throw; `plugins/errorHandler.ts`
formats. That keeps the contract in exactly one place.

### Scrub `code` as well as `message`

**Never leak internals on 5xx — and that includes the `code` field.** Scrubbing
only `message` still hands the caller a Postgres SQLSTATE (`23505` = unique
violation, which describes the schema) or a Fastify code (`FST_ERR_*`, internal
naming that changes across majors). Both become part of the public contract the
moment a client branches on them.

The rule the handler implements:

| Error | `code` sent |
|---|---|
| 5xx, anything | `INTERNAL_ERROR` |
| `ApiError` we raised | its own `code` |
| any other 4xx | mapped from status via `CODE_BY_STATUS` |
| unknown route | `NOT_FOUND` (separate handler) |

So a route that wants a specific code throws `ApiError`; anything else gets a
generic code derived from status. Codes clients see are ours and stable.

**When testing this, throw an error that actually carries a `code`.** A bare
`new Error(...)` has nothing to leak, so a test using one passes whether or not
the scrubbing works — which is exactly how the first version of this handler
shipped with the leak in place.

**Override Fastify's default 404**, which does not match the envelope.

---

## 3. Health checks: liveness ≠ readiness

| Endpoint | Question | Checks | Status |
|---|---|---|---|
| `/health` | is the process alive? | nothing | always 200 |
| `/ready` | can it serve traffic? | Postgres, Redis | 503 if any fail |

**Do not merge them.** If the liveness probe consulted the database, a brief
database outage would make an orchestrator conclude the process is dead and
restart it. Restarting does not fix the database, so the outage gains a restart
loop.

Two further details:

- **Check all dependencies, don't short-circuit.** `Promise.allSettled` over
  `Promise.race`-style early return, because the first thing you need to know is
  *which* dependency is down.
- **Bound every check with a timeout.** A readiness probe that hangs is as
  useless as one that fails.

### An unreachable dependency must not prevent startup

Startup performs **no eager connection to a dependency**. `pg.Pool` connects
lazily; the Redis client's first `connect()` is deliberately not awaited.

This matters because the two behaviours fail differently:

| Dependency down | Blocking startup | Non-blocking (required) |
|---|---|---|
| Postgres | process exits | process starts, `/ready` 503 |
| Redis | process exits | process starts, `/ready` 503 |

Blocking is worse than it looks. An orchestrator sees a process that cannot
start and restarts it forever; restarting does not fix Redis, so an outage gains
a crash loop. Non-blocking lets the instance sit not-ready and recover on its
own when the dependency returns — which is precisely what readiness is for.

Awaiting `client.connect()` also fails *badly*: node-redis retries forever, so
the plugin promise never settles, Fastify's plugin timeout fires, and startup
dies with `AVV_ERR_PLUGIN_EXEC_TIMEOUT` rather than a message anyone can act on.

Two supporting details:

- `disableOfflineQueue: true` on the Redis client, so a command issued while
  disconnected fails immediately instead of queueing — otherwise `/ready` waits
  out its own timeout rather than reporting the outage.
- `main()` has a `.catch()` in `server.ts`, so anything unexpected that still
  escapes produces one clear message and exit code 1.

**Known limitation: reconnect logging is unbounded.** Because the client now
retries forever instead of killing the process, a sustained Redis outage writes
one error line per attempt (backing off to every 3s). Overnight that is a lot of
noise, and it can bury unrelated problems. Taming it — throttle, or log the
first failure at `error` and the rest at `debug` — belongs to S6 (observability),
not here. Recorded so it is a known trade-off rather than a surprise.

---

## 4. Testing

| Level | Location | Needs infra |
|---|---|---|
| Unit | `src/**/*.test.ts` | no |

Use `app.inject()` rather than a real port. Substitute dependencies with test
doubles so the suite stays fast and can simulate failures that are awkward to
produce against a real service:

```ts
const app = Fastify({ logger: false })
app.decorate('db', { query: async () => { throw new Error('down') } } as never)
await app.register(healthRoutes)
```

Casting a double with `as never` is the accepted cost of substituting for a
`Pool`; say so in a comment.

**Test the boundary, not just the happy path.** The most valuable assertions in
`src/routes/health.test.ts` are the ones proving `/health` stays 200 while every
dependency is down — that is the property that would otherwise regress silently.

`@typescript-eslint/no-explicit-any` is an error. Do not reach for `any` to make
a type problem go away — see section 5.

---

## 5. `any` hides real bugs, not just lint warnings

Removing an `any` in `ArticleDetail.tsx` (S0) exposed that `{...props}` was
spreading HTML `<code>` attributes onto `SyntaxHighlighter`, whose `style` prop
means the highlight theme. An element style was overriding the theme object.

The lint warning was the least of it. **When `any` is removed and the type
checker immediately complains, the complaint is usually a real defect that was
being suppressed** — treat it as a finding, not as an obstacle.

---

## 6. Dependency discipline

**Do not accept the latest major by default.** `pnpm add` resolves to latest, and
a freshly released major drags its ecosystem behind it. In S0, installing
`typescript` pulled v7, which `typescript-eslint@8` does not support
(`>=4.8.4 <6.1.0`) — the toolchain broke before a line of application code was
written. Pin deliberately and re-check:

```bash
pnpm peers check
```

**`@types/node` must match the runtime.** Types describe the runtime's API
surface; `@types/node@26` against Node 22 type-checks code that calls functions
that do not exist at runtime.

Versions in use (S0):

| Package | Pinned | Why |
|---|---|---|
| `typescript` | `^5.9` | v7 is not yet supported by `typescript-eslint` |
| `@types/node` | `^22` | matches the Node 22 runtime |

---

## 7. pnpm build-script allowlist

pnpm 12 blocks dependency build scripts by default. Any package needing a
postinstall must be allowed explicitly in `pnpm-workspace.yaml`, or install fails
with `ERR_PNPM_IGNORED_BUILDS`:

```yaml
allowBuilds:
  esbuild: true   # vite cannot start without its postinstall
```

An allowlist entry is a deliberate decision that a package's install script may
execute. Add one only when the failure makes clear it is required.
