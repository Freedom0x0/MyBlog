# Backend Architecture

> Layering, instance assembly, and module resolution.

---

## 1. Layer boundaries

```
routes        HTTP boundary: parse → validate → call service → serialize
  ↓           no business rules, no SQL
services      business logic: depends only on repositories and injected deps
  ↓           no knowledge of HTTP (never touches req/reply), no SQL dialect
repositories  data access: SQL statements and row ↔ domain mapping
  ↓           no business rules
PostgreSQL
```

**Dependencies point downward only.** A `service` that references `request` or
contains a `SELECT` is a design error, not a shortcut. This is the first thing to
check in review, because once it slips the layering stops meaning anything.

An empty layer is acceptable while a module is small — `apps/api` currently has
routes only. What is not acceptable is a route that reaches for the database
directly "just this once."

---

## 2. `app.ts` assembles, `server.ts` listens

`buildApp()` returns a Fastify instance and **never calls `listen()`**.
`server.ts` owns every process-level concern: reading the environment, binding a
port, handling signals.

This is what makes the API testable. Tests import `buildApp` and drive it with
`app.inject()`, which runs the full routing stack — hooks, validation, error
handling — without binding a port. Anything that calls `listen()` inside a
module cannot be tested this way.

```ts
// test
const app = await buildApp({ config })
const response = await app.inject({ method: 'GET', url: '/ready' })
```

---

## 3. Plugin encapsulation

Fastify plugins are **scoped by default**: a decorator added inside a plugin is
visible only to that plugin and its children. A route registered elsewhere would
see `app.db` as `undefined`.

Infrastructure plugins therefore wrap themselves in `fastify-plugin` to opt out
of scoping. This applies to anything the rest of the app must reach.

```ts
export const dbPlugin = fp(async (app, options: { config: Config }) => {
  const pool = new Pool({ connectionString: options.config.DATABASE_URL })
  app.decorate('db', pool)
})
```

**TypeScript does not see decorators without help.** Each decorating plugin must
also augment the interface, or `app.db` fails to type-check everywhere it is used:

```ts
declare module 'fastify' {
  interface FastifyInstance {
    db: Pool
  }
}
```

Registration order matters: infrastructure first, then things that depend on it,
then the error handler so it covers errors thrown by earlier plugins.

---

## 4. Module resolution: explicit `.js` extensions

`apps/api` runs under Node's own ESM loader, not a bundler. Its tsconfig
therefore sets `module`/`moduleResolution` to `nodenext`, which override the
`bundler` settings used by the frontend.

Under `nodenext`, relative imports **must carry the `.js` extension** even
though the source file is `.ts`:

```ts
import { buildApp } from './app.js'      // correct
import { buildApp } from './app'         // compiles, then fails at runtime
```

`tsc` does not add extensions to emitted ESM. An extension-less import
type-checks cleanly and then throws `ERR_MODULE_NOT_FOUND` from `dist/`.

**This is why the build output is executed, not just compiled.** A build that
compiles is not evidence that it runs:

```bash
pnpm --filter api build && node apps/api/dist/server.js
```

---

## 5. Build and test layout

Tests live next to the code they cover (`src/**/*.test.ts`), so
`tsconfig.build.json` must exclude them explicitly — otherwise they are compiled
into `dist/` and shipped.

| File | Purpose |
|---|---|
| `tsconfig.json` | `noEmit: true`, used by `check` and the editor |
| `tsconfig.build.json` | extends it with `noEmit: false`, excludes tests |
| `vitest.config.ts` | `include: ['src/**/*.test.ts']` |
