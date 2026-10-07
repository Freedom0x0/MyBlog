/**
 * Schema migration runner.
 *
 * Written by hand rather than adopted from a package on purpose (R11): the whole
 * subject of this exercise is what a migration tool does — ordering, a version
 * table, concurrency protection, transactional application, reversibility. A
 * dependency would also read DATABASE_URL itself, splitting configuration into a
 * second source and losing the "one place parses the environment" rule.
 *
 * Three properties are load-bearing and each answers a specific production
 * failure:
 *
 * 1. Every migration must ship an up AND a down file, or the run refuses to
 *    start. An unreversible migration is how a bad deploy becomes an outage.
 * 2. A batch applies inside ONE transaction. Postgres DDL is transactional, so
 *    a migration that fails halfway leaves the schema untouched instead of
 *    half-applied.
 * 3. A transaction-scoped advisory lock means two instances migrating at once
 *    serialize, and a crashed runner cannot strand the lock — it is released
 *    when the transaction ends.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client } from 'pg'
import { loadConfig } from '../config/index.js'

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url)
const LOCK_KEY = 'portal_schema_migrations'

/** NNNN_name.up.sql / NNNN_name.down.sql */
const FILE_RE = /^(\d{4})_([a-z0-9][a-z0-9_-]*)\.(up|down)\.sql$/

export interface Migration {
  id: string
  name: string
  upSql: string
  downSql: string
}

export class MigrationError extends Error {}

/**
 * Read and validate a migrations directory.
 *
 * `dir` is a parameter so the validation rules can be tested against a temp
 * directory without a database.
 *
 * Validation is deliberately strict and happens before anything touches the
 * database: failing here costs nothing, failing midway through a batch does not
 * (the transaction rolls back, but the operator still has to work out why).
 */
export async function discoverMigrations(
  dir: URL | string = MIGRATIONS_DIR,
): Promise<Migration[]> {
  const entries = (await readdir(dir)).filter(
    (file) => !file.startsWith('.') && file.endsWith('.sql'),
  )

  const byId = new Map<string, { name: string; up?: string; down?: string }>()

  for (const file of entries) {
    const match = FILE_RE.exec(file)
    if (!match) {
      throw new MigrationError(
        `Unexpected file in migrations/: ${file}\n` +
          `  Expected NNNN_name.up.sql plus a matching NNNN_name.down.sql`,
      )
    }

    const [, id, name, kind] = match
    const existing = byId.get(id)

    if (existing && existing.name !== name) {
      throw new MigrationError(
        `Migration ${id} has two different names: "${existing.name}" and "${name}"`,
      )
    }

    byId.set(id, {
      name,
      up: existing?.up,
      down: existing?.down,
      [kind]: file,
    })
  }

  const ids = [...byId.keys()].sort()

  /**
   * `dir` may be a file URL (the default, so it resolves correctly from both src/
   * and dist/) or a plain path (what tests pass). new URL(file, string) throws, so
   * the resolution has to branch rather than assume one form.
   */
  const resolveFile = (file: string): URL | string =>
    typeof dir === 'string' ? join(dir, file) : new URL(file, dir)

  if (ids.length === 0) {
    throw new MigrationError('No migrations found in migrations/')
  }

  const migrations: Migration[] = []

  for (const id of ids) {
    const found = byId.get(id)!

    if (!found.up || !found.down) {
      const missing = found.up ? 'down' : 'up'
      throw new MigrationError(
        `Migration ${id}_${found.name} is missing its ${missing} file. ` +
          `Every migration must ship both directions — an unreversible one is how a bad deploy becomes an outage.`,
      )
    }

    migrations.push({
      id,
      name: found.name,
      upSql: (await readFile(resolveFile(found.up))).toString(),
      downSql: (await readFile(resolveFile(found.down))).toString(),
    })
  }

  return migrations
}

/**
 * Run `work` against a single connection inside one transaction, holding an
 * advisory lock for its duration. The version table is created on demand so the
 * very first run works on an empty database.
 */
async function withMigrationTransaction<T>(
  work: (client: Client, applied: string[]) => Promise<T>,
): Promise<T> {
  const { DATABASE_URL } = loadConfig()
  const client = new Client({ connectionString: DATABASE_URL })

  await client.connect()

  try {
    await client.query('begin')

    // pg_advisory_xact_lock (not pg_advisory_lock): released automatically at
    // commit or rollback, so a crashed process cannot leave the lock held.
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY])

    await client.query(
      `create table if not exists schema_migrations (
         id text primary key,
         applied_at timestamptz not null default now()
       )`,
    )

    const { rows } = await client.query('select id from schema_migrations order by id')
    const applied = rows.map((row: { id: string }) => row.id)

    const result = await work(client, applied)

    await client.query('commit')
    return result
  } catch (error) {
    // Postgres DDL is transactional, so this genuinely undoes partial work —
    // including tables created by a migration that failed halfway.
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

/** Apply every migration not yet recorded. Returns the ids newly applied. */
export async function migrateUp(): Promise<string[]> {
  const migrations = await discoverMigrations()

  const applied = await withMigrationTransaction(async (client, alreadyApplied) => {
    // Anything recorded but absent from disk means the checkout and the
    // database disagree. Refuse rather than guess.
    const unknown = alreadyApplied.filter((id) => !migrations.some((m) => m.id === id))
    if (unknown.length > 0) {
      throw new MigrationError(
        `Database has migrations with no file on disk: ${unknown.join(', ')}\n` +
          `  The schema and this checkout disagree; refusing to continue.`,
      )
    }

    const appliedSet = new Set(alreadyApplied)
    const pending = migrations.filter((m) => !appliedSet.has(m.id))

    for (const migration of pending) {
      await client.query(migration.upSql)
      await client.query('insert into schema_migrations (id) values ($1)', [migration.id])
    }

    return pending
  })

  // Reported only after the commit. Logging progress from inside the transaction
  // claimed successes that a later failure rolled back — the run would print
  // "applied 0002_ok" while 0002 ended up not applied at all.
  if (applied.length === 0) {
    console.log('  already up to date')
  }
  for (const migration of applied) {
    console.log(`  applied ${migration.id}_${migration.name}`)
  }

  return applied.map((m) => m.id)
}

/**
 * Reverse the most recently applied migrations, newest first (foreign keys
 * require it).
 */
export async function migrateDown(count: number | 'all'): Promise<string[]> {
  const migrations = await discoverMigrations()

  const reverted = await withMigrationTransaction(async (client, alreadyApplied) => {
    const appliedSet = new Set(alreadyApplied)
    // Newest first. Reverse-sorted ids, restricted to what is actually applied.
    const toRevert = migrations
      .filter((m) => appliedSet.has(m.id))
      .reverse()
      .slice(0, count === 'all' ? undefined : count)

    for (const migration of toRevert) {
      await client.query(migration.downSql)
      await client.query('delete from schema_migrations where id = $1', [migration.id])
    }

    return toRevert
  })

  if (reverted.length === 0) {
    console.log('  nothing to revert')
  }
  for (const migration of reverted) {
    console.log(`  reverted ${migration.id}_${migration.name}`)
  }

  return reverted.map((m) => m.id)
}

/** Which migrations exist, which are applied. */
export function migrateStatus(): Promise<{ id: string; name: string; applied: boolean }[]> {
  return (async () => {
    const migrations = await discoverMigrations()

    return withMigrationTransaction(async (_client, applied) => {
      const appliedSet = new Set(applied)

      const rows = migrations.map((m) => ({ id: m.id, name: m.name, applied: appliedSet.has(m.id) }))

      for (const row of rows) {
        console.log(`  ${row.applied ? '✓' : '·'} ${row.id}_${row.name}`)
      }

      return rows
    })
  })()
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2)

  switch (command) {
    case 'up':
      await migrateUp()
      return
    case 'down':
      await migrateDown(argument === 'all' ? 'all' : Number.parseInt(argument ?? '1', 10))
      return
    case 'status':
      await migrateStatus()
      return
    default:
      console.error('Usage: migrate <up | down [n|all] | status>')
      process.exit(2)
  }
}

// Only self-execute as a script; tests import the functions. Compare file URLs,
// not paths — argv[1] on Windows carries backslashes and a drive letter that will
// never textually match import.meta.url.
const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url

if (invokedDirectly) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
