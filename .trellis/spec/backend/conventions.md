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

---

## 8. Migrations

Plain SQL files in `supabase/migrations/`, applied in filename order. No migration
tooling yet, so ordering and idempotency are manual.

### Dollar-quote any literal that can contain a quote character

Never use `'...'` for markdown, HTML, or JSON payloads. Any ASCII apostrophe inside
terminates the literal early, and the rest of the file is then parsed as SQL.

Measured failure — a migration seeding article markdown that contained a TypeScript
example:

```
ERROR:  syntax error at or near "demo"
LINE 6: ...eturn { data }\n}\n\nconst r = ok({ id: 1, name: 'demo' })
```

#### Wrong

```sql
update public.articles
set content_md = '# Title\n\nconst r = ok({ id: 1, name: ''demo'' })'
where slug = 'x';
```

Escaping every apostrophe in a code sample is fragile, and the next quoted word in
the prose breaks it again.

#### Correct

```sql
update public.articles
set content_md = $md$
# Title

const r = ok({ id: 1, name: 'demo' })
$md$
where slug = 'x';
```

Choose a tag that cannot occur inside the payload (`$md$`, `$ex$`). The content is
then byte-for-byte literal — newlines included, which is why dollar-quoted seed
data stays readable as the markdown it actually is.

**Verify by executing, not by reading.** A syntactically broken migration looks
completely normal in an editor. Apply each migration to a scratch database and
check the exit status; distinguish *syntax* errors (a real defect) from missing
Supabase objects such as the `auth` schema (expected locally, not a finding).

### Don't edit a migration that has already been applied

- **Symptom**: the fix is in the repository but the deployed database still behaves the old way.
- **Cause**: applied migrations are not re-run. Editing one changes *fresh* setups only — one repository, two states.
- **Fix**: add a new migration whose SQL is idempotent by construction (`create or replace function`, `add column if not exists`).
- **Prevention**: before touching anything under `supabase/migrations/`, ask whether it has already been applied. If yes, it is a new file, not a change.

### Don't authorize on claims the user can write

- **Symptom**: `is_admin()` reads `auth.jwt() -> 'user_metadata'`, so any signed-in user escalates by running `supabase.auth.updateUser({ data: { user_name: 'guoshaoran' } })` and refreshing the JWT.
- **Why it matters here**: the anon key ships in the client bundle by design, so RLS is the *only* boundary between a browser and the table — and this places the decision on attacker-controlled input.
- **Fix**: authorize on `app_metadata` (writable only via `service_role`), or in the self-built API on a real `users.is_admin` column. Owned by S2; see `technical_architecture.md` defect D1.
- **Prevention**: when writing any authorization check, name the party that can write the value you are reading. If the answer is "the user", it is not an authorization input.

---

## 9. Indexes: prove they are usable, at scale

Two rules that read as trivia and both cost a full scan when broken.

### `ORDER BY` must match the index expression exactly, including `NULLS`

```sql
-- index
create index articles_list_keyset on articles (status, published_at desc nulls last, id desc);
```

```sql
-- wrong: Postgres defaults to NULLS FIRST for DESC, so this does not match the
-- index, and the planner gives up on index ordering and sorts instead
order by published_at desc, id desc

-- right
order by published_at desc nulls last, id desc
```

Measured on 5000 rows: mismatched → **2505 rows scanned + Sort**; aligned →
**Limit over Index Scan, 10 rows, 3 buffers, no Sort node**.

Correctness is unaffected — which is why this hides. The query returns the right
rows either way; only the cost changes.

### GIN serves `@>`, and nothing else

```sql
-- cannot use a GIN index; always a post-scan filter
where 'needle' = any (tags)

-- can
where tags @> array['needle']::text[]
```

Identical meaning to a reader, different execution plan. Measured with a selective
tag (3 of 5000): containment `Bitmap Index Scan on articles_tags_gin`, 10 buffers,
0.275 ms; the `any` form `Seq Scan`, `Rows Removed by Filter: 4998`, 109 buffers,
1.767 ms.

**Write the comment and the code together.** The schema comment promised `@>` while
the repository used `= any`, and the index was dead for weeks of local use because
nothing measured it.

### A small table cannot demonstrate any of this

Six seeded rows produce a plausible plan for a broken query. **Load a few thousand
rows into a scratch database and re-check.** Better: make the filter actually
selective — an early attempt matched every row, so both forms gave the same plan and
the test passed with the defect fully in place.

---

## 10. CI environment scope

Job-level `env:` is visible to **every** step. When stage C added `DATABASE_URL` at
job level for the test database, a later step that asserted
"`node dist/server.js` exits non-zero on missing config" stopped being able to fail:
the server started, listened, and hung until the job timed out.

Scrub it explicitly in the steps that need its absence:

```bash
env -u DATABASE_URL -u REDIS_URL node apps/api/dist/server.js
```

**Rule:** a step that asserts a negative must have the variables under test removed,
not merely "not set by that step".

**The mirror mistake: required keys must be declared in CI too.** S2 added
`JWT_SECRET`, `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` as required config, and CI
kept only `DATABASE_URL`/`REDIS_URL` — so "Migrate and seed" and every integration
suite died on a `ConfigError`. Everything was green locally because
`apps/api/.env` exists and CI has no such file.

A required config key is therefore a **CI contract**, not a local convenience: when
`loadConfig` gains a key, `ci.yml`'s `env:` block is part of the same change.
