import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverMigrations, MigrationError } from './migrate.js'

/**
 * The runner's validation rules, tested against a temp directory.
 *
 * These are the rules that make a bad deploy recoverable, so they are checked
 * before anything touches a database — which is also why they need no DB here.
 * The transactional properties (batch atomicity, advisory lock) do, and are
 * covered by the integration suite once a test database exists.
 */
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'migrate-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function add(id: string, name: string, kind: 'up' | 'down', body = 'select 1;') {
  await writeFile(join(dir, `${id}_${name}.${kind}.sql`), body)
}

describe('discoverMigrations', () => {
  it('returns migrations ordered by id with both scripts read', async () => {
    await add('0002', 'second', 'up')
    await add('0002', 'second', 'down')
    await add('0001', 'first', 'up')
    await add('0001', 'first', 'down')

    const found = await discoverMigrations(dir)

    // Filesystem order is not creation order; ids must decide.
    expect(found.map((m) => m.id)).toEqual(['0001', '0002'])
  })

  it('reads file content verbatim, including quote characters', async () => {
    // Migration 04 of the old Supabase set died on exactly this: an apostrophe
    // inside a single-quoted SQL literal. The runner must not mangle payloads.
    const body = `update t set c = 'name: demo' where slug = 'x';`
    await add('0001', 'quotes', 'up', body)
    await add('0001', 'quotes', 'down')

    const [first] = await discoverMigrations(dir)

    expect(first?.upSql).toBe(body)
  })

  it('rejects a migration with no down file', async () => {
    await add('0001', 'one_way', 'up')

    await expect(discoverMigrations(dir)).rejects.toThrow(MigrationError)
    await expect(discoverMigrations(dir)).rejects.toThrow(/missing its down file/)
  })

  it('rejects a migration with no up file', async () => {
    await add('0001', 'orphan_down', 'down')

    await expect(discoverMigrations(dir)).rejects.toThrow(/missing its up file/)
  })

  it('rejects an unrecognised filename rather than ignoring it', async () => {
    // Silently skipping a mystery .sql file is how an unapplied migration hides.
    await add('0001', 'ok', 'up')
    await add('0001', 'ok', 'down')
    await writeFile(join(dir, 'notes.sql'), 'nothing useful')

    await expect(discoverMigrations(dir)).rejects.toThrow(/Unexpected file in migrations\/: notes\.sql/)
  })

  it('rejects two files sharing an id but disagreeing on name', async () => {
    await add('0001', 'alpha', 'up')
    await add('0001', 'beta', 'down')

    await expect(discoverMigrations(dir)).rejects.toThrow(/two different names/)
  })

  it('rejects an empty directory', async () => {
    await expect(discoverMigrations(dir)).rejects.toThrow(/No migrations found/)
  })

  it('accepts the repository’s own migrations directory', async () => {
    // Runs the same validation the CLI does, so a broken pairing fails here
    // rather than on some other developer's machine.
    const found = await discoverMigrations()

    expect(found.length).toBeGreaterThan(0)
    for (const migration of found) {
      expect(migration.upSql.length).toBeGreaterThan(0)
      expect(migration.downSql.length).toBeGreaterThan(0)
    }
  })
})
