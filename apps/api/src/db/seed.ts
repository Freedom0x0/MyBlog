/**
 * Seed the local database from `fixtures/*.md`.
 *
 * Two behaviours are deliberate:
 *
 * - **Idempotent.** Articles upsert on slug and comments use fixed UUIDs, so
 *   running this twice leaves the same data. A seed that must be preceded by a
 *   manual truncate cannot be run in CI.
 * - **Refuses to run in production.** This is development data; a `pnpm seed`
 *   against a real database should fail loudly rather than overwrite rows.
 */
import { readdir, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { Client } from 'pg'
import { loadConfig } from '../config/index.js'
import { FixtureError, parseFixture, type Fixture } from './frontmatter.js'

const FIXTURES_DIR = new URL('../../fixtures/', import.meta.url)

/**
 * Fixed ids and a fixed author make the seed repeatable. Random UUIDs would
 * insert a fresh duplicate on every run.
 */
const DEMO_USERS = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    githubLogin: 'guoshaoran',
    displayName: 'Guoshaoran',
    isAdmin: true,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    githubLogin: 'reader-bot',
    displayName: 'Reader Bot',
    isAdmin: false,
  },
]

const DEMO_COMMENTS = [
  {
    id: '33333333-3333-4333-8333-333333333333',
    slug: 'normal-published',
    userId: DEMO_USERS[1]!.id,
    parentId: null,
    content: '第一层评论，用于验证平铺返回与建树。',
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    slug: 'normal-published',
    userId: DEMO_USERS[0]!.id,
    // References the comment above: exercises the parent_id self-foreign-key.
    parentId: '33333333-3333-4333-8333-333333333333',
    content: '这是一条嵌套回复。',
  },
]

export class SeedError extends Error {}

export async function readFixtures(dir: URL = FIXTURES_DIR): Promise<Fixture[]> {
  const entries = (await readdir(dir)).filter((file) => file.endsWith('.md'))

  if (entries.length === 0) {
    throw new SeedError('No fixtures found in fixtures/')
  }

  return Promise.all(
    entries.map(async (file) => {
      const raw = await readFile(new URL(file, dir))
      try {
        return parseFixture(raw.toString('utf8'), `fixtures/${file}`)
      } catch (error) {
        if (error instanceof FixtureError) throw error
        throw error
      }
    }),
  )
}

export async function seed(): Promise<{ articles: number; comments: number }> {
  const config = loadConfig()

  if (config.NODE_ENV === 'production') {
    throw new SeedError('Refusing to seed NODE_ENV=production — this is development data.')
  }

  const fixtures = await readFixtures()
  const client = new Client({ connectionString: config.DATABASE_URL })

  await client.connect()

  try {
    // One transaction: a seed that fails halfway leaves a database whose state
    // nobody can reason about, and the next run would not fix it.
    await client.query('begin')

    for (const user of DEMO_USERS) {
      await client.query(
        `insert into users (id, github_login, display_name, is_admin)
         values ($1, $2, $3, $4)
         on conflict (id) do update
           set github_login = excluded.github_login,
               display_name = excluded.display_name,
               is_admin     = excluded.is_admin`,
        [user.id, user.githubLogin, user.displayName, user.isAdmin],
      )
    }

    for (const fixture of fixtures) {
      await client.query(
        `insert into articles
           (slug, title, excerpt, content_md, category, tags, cover_image,
            read_time, status, published_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (slug) do update set
           title        = excluded.title,
           excerpt      = excluded.excerpt,
           content_md   = excluded.content_md,
           category     = excluded.category,
           tags         = excluded.tags,
           cover_image  = excluded.cover_image,
           read_time    = excluded.read_time,
           status       = excluded.status,
           published_at = excluded.published_at,
           updated_at   = now()`,
        [
          fixture.slug,
          fixture.title,
          fixture.excerpt,
          fixture.body,
          fixture.category,
          fixture.tags,
          fixture.coverImage,
          fixture.readTime,
          fixture.status,
          fixture.publishedAt,
        ],
      )
    }

    for (const comment of DEMO_COMMENTS) {
      const { rows } = await client.query('select id from articles where slug = $1', [
        comment.slug,
      ])
      const articleId = rows[0]?.id

      if (articleId === undefined) {
        throw new SeedError(
          `Seed comment references unknown article slug '${comment.slug}'`,
        )
      }

      await client.query(
        `insert into comments (id, article_id, user_id, parent_id, content)
         values ($1, $2, $3, $4, $5)
         on conflict (id) do update set content = excluded.content`,
        [comment.id, articleId, comment.userId, comment.parentId, comment.content],
      )
    }

    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }

  return { articles: fixtures.length, comments: DEMO_COMMENTS.length }
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url

if (invokedDirectly) {
  await seed().then(
    (result) => console.log(`  seeded ${result.articles} articles, ${result.comments} comments`),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    },
  )
}
