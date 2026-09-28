/**
 * Grant or revoke the administrator flag from the command line.
 *
 * Deliberately a CLI and not an HTTP endpoint: the ability to mint an admin is the
 * most powerful operation in the system, and exposing it over the network means a
 * single authorisation bug anywhere becomes a full takeover. Requiring shell
 * access makes the blast radius "whoever can already run commands on this box".
 *
 * Bootstrapping matters more than it looks. The very first admin cannot be
 * granted by an admin, so "insert them with SQL" is the only option in practice —
 * and that is how a project ends up with an undocumented way in. This command is
 * the documented one.
 */
import { Client } from 'pg'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../config/index.js'

export class AdminError extends Error {}

async function setUserAdmin(login: string, isAdmin: boolean): Promise<number> {
  const { DATABASE_URL } = loadConfig()
  const client = new Client({ connectionString: DATABASE_URL })
  await client.connect()

  try {
    // No upsert: silently creating a user here would hand admin rights to a typo
    // in a login name, and the row would look legitimate afterwards.
    const { rowCount } = await client.query(
      'update users set is_admin = $2 where github_login = $1',
      [login, isAdmin],
    )

    if ((rowCount ?? 0) === 0) {
      throw new AdminError(
        `No user with login '${login}'. They must sign in once before being ` +
          `granted access; this command never creates accounts.`,
      )
    }

    return rowCount ?? 0
  } finally {
    await client.end()
  }
}

async function main(): Promise<void> {
  const [action, login] = process.argv.slice(2)

  if (action !== 'grant' && action !== 'revoke' || login === undefined) {
    console.error('Usage: admin <grant|revoke> <github-login>')
    process.exit(2)
  }

  const isAdmin = action === 'grant'

  // Announce the effect before touching anything: the operator should see whose
  // privileges are about to change without having to run it and ask afterwards.
  console.log(`${isAdmin ? 'Granting' : 'Revoking'} admin for '${login}'`)

  await setUserAdmin(login, isAdmin)
  console.log(`  done — '${login}' isAdmin=${String(isAdmin)}`)
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url

if (invokedDirectly) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
