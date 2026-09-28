import type { Pool } from 'pg'
import type { ArticleSummary } from 'shared'
import type { Cursor } from '../../lib/pagination.js'

/**
 * Data access only: SQL statements, and the row-to-domain translation.
 *
 * This is the ONE place snake_case becomes camelCase. Letting a `content_md` or
 * `published_at` key escape downwards into the service, or upwards into a
 * response, is how layer-boundary bugs get written — two layers then disagree
 * about the same field and nothing complains until a client does.
 */

/** A row as the list query returns it, before pagination decisions are made. */
export interface ArticleListRow {
  /** Internal id: the keyset tie-breaker. Never exposed in a response. */
  id: string
  /**
   * Full-precision UTC text of `published_at`, used only to build a cursor.
   *
   * Deliberately separate from `summary.publishedAt`: that is an ISO string with
   * millisecond precision because it is what a client renders, while Postgres
   * stores microseconds. Feeding the lossy wire value back as a keyset bound could
   * truncate the bound below the row it came from and repeat that row on the next
   * page. The cursor stays exact; the payload stays friendly.
   */
  cursorKey: string
  summary: ArticleSummary
}

/**
 * A single article as stored, whatever its status.
 *
 * `publishedAt` is nullable here on purpose: a draft legitimately has none. The
 * repository does not decide whether a row may be shown — that is a rule, and
 * rules live in the service. Mapping this row straight into an `ArticleSummary`
 * assumed visibility and crashed on drafts with a 500.
 */
export interface ArticleRecord {
  id: string
  slug: string
  title: string
  excerpt: string
  category: string
  tags: string[]
  coverImage: string | null
  readTime: number
  publishedAt: string | null
  status: string
  contentMd: string
}

/**
 * Columns shared by both queries. Never `select *`: the list response must not
 * carry article bodies, and an explicit column list also means a new column
 * cannot silently widen every payload.
 */
const LIST_COLUMNS = `
  id, slug, title, excerpt, category, tags, cover_image, read_time,
  published_at,
  to_char(published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_key
`

const DETAIL_COLUMNS = `
  id, slug, title, excerpt, category, tags, cover_image, read_time,
  published_at, content_md, status
`

export interface ListParams {
  /** Ask for one more than the page size — see `listPublished`. */
  limit: number
  cursor?: Cursor
  tag?: string
  category?: string
}

export class ArticleRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * The newest-published page, optionally filtered.
   *
   * `status = 'published'` lives here rather than in the service because this
   * method is named for it: `listPublished` returning drafts would be a lie.
   * `findBySlug` is different — it returns whatever it finds and lets the service
   * decide visibility, because "is this draft public?" is a rule, not a query.
   *
   * Rows are fetched `limit + 1`. Whether more exist is then known from the row
   * count itself, instead of a second COUNT(*) query per page.
   */
  async listPublished(params: ListParams): Promise<ArticleListRow[]> {
    const conditions: string[] = [`status = 'published'`]
    const values: unknown[] = []
    const param = (): string => `$${values.length + 1}`

    if (params.category !== undefined) {
      conditions.push(`category = ${param()}`)
      values.push(params.category)
    }

    if (params.tag !== undefined) {
      // Array containment, which is what the GIN index on tags can serve.
      conditions.push(`${param()} = any (tags)`)
      values.push(params.tag)
    }

    if (params.cursor !== undefined) {
      // Placeholders must be numbered explicitly here: `param()` derives its
      // number from values.length, so calling it twice inside one template string
      // — before the push — yields the SAME number twice, and Postgres then tries
      // to cast one value to two types: `cannot cast type timestamp with time zone
      // to uuid`.
      const timeParam = `$${values.length + 1}`
      const idParam = `$${values.length + 2}`
      values.push(params.cursor.p, params.cursor.i)

      // Row-value comparison: `(a, b) < (x, y)` is exactly the lexicographic
      // meaning the ORDER BY establishes. Writing it out as
      // `a < x OR (a = x AND b < y)` is the same thing with more ways to be wrong.
      conditions.push(`(published_at, id) < (${timeParam}::timestamptz, ${idParam}::uuid)`)
    }

    values.push(params.limit)
    const limitParam = `$${values.length}`

    const result = await this.pool.query<ArticleRow>(
      `select ${LIST_COLUMNS}
         from articles
         where ${conditions.join('\n           and ')}
         order by published_at desc, id desc
         limit ${limitParam}`,
      values,
    )

    return result.rows.map(toListRow)
  }

  async findBySlug(slug: string): Promise<ArticleRecord | null> {
    const result = await this.pool.query<ArticleRow & { content_md: string; status: string }>(
      `select ${DETAIL_COLUMNS} from articles where slug = $1 limit 1`,
      [slug],
    )

    const row = result.rows[0]
    if (row === undefined) return null

    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      excerpt: row.excerpt,
      category: row.category,
      tags: row.tags,
      coverImage: row.cover_image,
      readTime: row.read_time,
      // NULL is the normal case for a draft, not an error to be mapped away.
      publishedAt: row.published_at === null ? null : row.published_at.toISOString(),
      status: row.status,
      contentMd: row.content_md,
    }
  }

}

/** Shape of a row as Postgres returns it. Snake_case is correct here and only here. */
interface ArticleRow {
  id: string
  slug: string
  title: string
  excerpt: string
  category: string
  tags: string[]
  cover_image: string | null
  read_time: number
  published_at: Date | null
  cursor_key: string
}

function toListRow(row: ArticleRow): ArticleListRow {
  /**
   * The list query filters on `status = 'published'` and the schema enforces
   * `published_needs_timestamp`, so null here means the database no longer obeys
   * its own invariant. Failing loudly beats inventing a timestamp — an empty or
   * fabricated date would flow straight into a client's rendering.
   */
  if (row.published_at === null) {
    throw new Error(`Invariant broken: published article ${row.id} has no published_at`)
  }

  return {
    id: row.id,
    cursorKey: row.cursor_key,
    summary: {
      slug: row.slug,
      title: row.title,
      excerpt: row.excerpt,
      category: row.category,
      tags: row.tags,
      coverImage: row.cover_image,
      readTime: row.read_time,
      publishedAt: row.published_at.toISOString(),
    },
  }
}
