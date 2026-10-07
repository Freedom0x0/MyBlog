import type { Pool } from 'pg'
import type { SessionUser } from 'shared'
import type { OAuthProfile } from './provider.js'

/**
 * Data access for identity. Routes and guards must not contain SQL — this is the
 * only place the users table is written, and the only place that knows its
 * snake_case column names.
 */
export class AuthRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Returns the internal user id for a provider identity, creating the row on
   * first sign-in.
   *
   * Keyed on `github_id`, never on `login`. An `on conflict (github_login)` here
   * would let someone who registered a released GitHub username be returned the
   * *previous* holder's row — including its `is_admin`. Conflict resolution on
   * `github_id` makes that impossible: a different person is a different row, and
   * two rows may legitimately share a login across time.
   *
   * `is_admin` appears only in the insert path. Including it in the update list
   * would demote an admin on every sign-in; the reverse mistake — `true` in the
   * insert — would hand out the role.
   */
  async upsertFromProfile(profile: OAuthProfile): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `insert into users (github_id, github_login, display_name, avatar_url, is_admin)
         values ($1, $2, $3, $4, false)
       on conflict (github_id) where github_id is not null do update
         set github_login = excluded.github_login,
             display_name = excluded.display_name,
             avatar_url   = excluded.avatar_url
       returning id`,
      [profile.githubId, profile.login, profile.displayName, profile.avatarUrl],
    )

    return rows[0]!.id
  }

  /** The identity a session's subject maps to, or null if the account is gone. */
  async findSessionUser(userId: string): Promise<SessionUser | null> {
    const { rows } = await this.pool.query<UserRow>(
      `select id, github_login, display_name, avatar_url, is_admin
         from users where id = $1`,
      [userId],
    )

    const row = rows[0]

    if (row === undefined) return null

    return {
      id: row.id,
      login: row.github_login,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      isAdmin: row.is_admin,
    }
  }

  /** True when the account behind a token still exists and is an admin. */
  async isAdmin(userId: string): Promise<boolean | null> {
    const { rows } = await this.pool.query<{ is_admin: boolean }>(
      'select is_admin from users where id = $1',
      [userId],
    )

    const row = rows[0]
    return row === undefined ? null : row.is_admin
  }

  /**
   * Resolves a login for the admin CLI.
   *
   * Returns every match rather than picking one: since a login is no longer unique,
   * `grant` on a name two rows share is ambiguous, and silently choosing the newest
   * or oldest would be a privilege decision made by an `order by` clause.
   */
  async findAllByLogin(login: string): Promise<{ id: string; githubId: number | null; isAdmin: boolean }[]> {
    const { rows } = await this.pool.query<{ id: string; github_id: string | null; is_admin: boolean }>(
      'select id, github_id::text, is_admin from users where github_login = $1',
      [login],
    )

    return rows.map((row) => ({
      id: row.id,
      githubId: row.github_id === null ? null : Number(row.github_id),
      isAdmin: row.is_admin,
    }))
  }

  async setAdmin(userId: string, isAdmin: boolean): Promise<void> {
    await this.pool.query('update users set is_admin = $2 where id = $1', [userId, isAdmin])
  }
}

interface UserRow {
  id: string
  github_login: string
  display_name: string | null
  avatar_url: string | null
  is_admin: boolean
}
