# Backend Development Guidelines

> Conventions for `apps/api` (Fastify + PostgreSQL + Redis).

---

## Overview

The API is a layered Node/TypeScript service. It is deliberately built without an
ORM, without a framework that pre-solves layering (NestJS), and without a
BaaS — the point of the project is to build and understand these layers, not to
consume them.

Two rules shape almost every decision below:

1. **The framework's native feature comes first.** Fastify already provides a
   pino logger, request ids, JSON-schema validation and a hook system. Reach for
   those before writing a plugin.
2. **Shared things must be stack-agnostic.** The portal aggregates modules
   written in different languages and frameworks, so anything crossing a
   boundary is expressed as plain data, not as a library-specific construct.

---

## Guidelines Index

| Guide | Description |
|-------|-------------|
| [Architecture](./architecture.md) | Layering, the app/server split, plugin encapsulation, ESM resolution |
| [Conventions](./conventions.md) | Config validation, error contract, health semantics, testing, dependencies |

---

## Quick reference

- Layer order is `routes → services → repositories`, dependencies point downward only.
- `app.ts` assembles; `server.ts` listens. Never `listen()` in a module tests import.
- Infrastructure decorators go through `fastify-plugin`, or they stay invisible to siblings.
- Relative imports carry an explicit `.js` extension — `tsc` will not add it.
- Config is validated once at boot and the process refuses to start on failure.
- `/health` checks nothing; `/ready` checks every dependency.
- Routes throw; a single error handler formats. No hand-built error bodies.

---

## Adding to this layer

When a new convention is established — or a bug teaches something that would
have been avoided by writing it down — add it to the relevant file above rather
than to this index. Keep examples taken from real code in this repository.
