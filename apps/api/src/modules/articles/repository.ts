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
  /**
   * Row modification time. Read back by the write path so the admin response can
   * carry it; the public contract never shows it, and `getPublished` simply omits
   * it from its explicit mapping — so widening the record here leaks nothing.
   */
  updatedAt: string
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
  published_at, content_md, status, updated_at
`

export interface ListParams {
  /** Ask for one more than the page size — see `listPublished`. */
  limit: number
  cursor?: Cursor
  tag?: string
  category?: string
}

/** Fully-resolved values for a new draft; the service has already applied defaults. */
export interface InsertDraftParams {
  slug: string
  title: string
  excerpt: string
  contentMd: string
  category: string
  tags: string[]
  coverImage: string | null
  readTime: number
}

/**
 * A partial update. `undefined` means "leave this column alone"; only
 * `publishedAt` is typed as `Date` because the service sets it only when a draft
 * is first published and must hand Postgres a timestamp, not a lossy string.
 */
export interface UpdatePatch {
  slug?: string
  title?: string
  excerpt?: string
  contentMd?: string
  category?: string
  tags?: string[]
  coverImage?: string | null
  readTime?: number
  status?: string
  /**
   * Candidate first-publish timestamp, applied with `coalesce` (see
   * `updateBySlug`): it lands only where `published_at` is still null.
   */
  publishedAt?: Date
}

export type UpdateResult =
  | { kind: 'updated'; record: ArticleRecord }
  | { kind: 'not_found' }
  | { kind: 'conflict' }

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
      // `@>` and nothing else: the GIN index only serves the containment
      // operator. `$tag = any (tags)` reads as the same question to a human but
      // is a post-scan Filter that can never touch articles_tags_gin, turning a
      // tag page into a full scan of the published set.
      conditions.push(`tags @> array[$${values.length + 1}]::text[]`)
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
         -- must match the index expression exactly, including NULLS LAST:
         -- without it the planner cannot use the index for ordering and
         -- falls back to a sort over the whole filtered set.
         order by published_at desc nulls last, id desc
         limit ${limitParam}`,
      values,
    )

    return result.rows.map(toListRow)
  }

  async findBySlug(slug: string): Promise<ArticleRecord | null> {
    const result = await this.pool.query<ArticleRecordRow>(
      `select ${DETAIL_COLUMNS} from articles where slug = $1 limit 1`,
      [slug],
    )

    const row = result.rows[0]
    if (row === undefined) return null

    return toArticleRecord(row)
  }

  /**
   * Insert a new article as a draft.
   *
   * `status` is hard-wired to `'draft'` and `published_at` left to its null
   * default — creation is not allowed to publish (design §1.1). The client's
   * status is discarded upstream in the schema; hard-coding it here too means
   * even a future caller that forgot to strip it cannot seed a published row.
   *
   * `on conflict (slug) do nothing` is the whole idempotency story (S3-R3): two
   * concurrent creates for the same slug race at the unique index, exactly one
   * inserts, the other returns zero rows and the service reads that as a
   * conflict. A "check then insert" would leave a window where both saw a free
   * slug and both wrote. Null return means "no row inserted"; it never leaks the
   * `23505` because `do nothing` swallows the violation before the driver sees it.
   */
  async insertDraft(input: InsertDraftParams): Promise<ArticleRecord | null> {
    const result = await this.pool.query<ArticleRecordRow>(
      `insert into articles
         (slug, title, excerpt, content_md, category, tags, cover_image, read_time, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'draft')
       on conflict (slug) do nothing
       returning ${DETAIL_COLUMNS}`,
      [
        input.slug,
        input.title,
        input.excerpt,
        input.contentMd,
        input.category,
        input.tags,
        input.coverImage,
        input.readTime,
      ],
    )

    const row = result.rows[0]
    return row === undefined ? null : toArticleRecord(row)
  }

  /**
   * Apply a partial update addressed by the current slug.
   *
   * The SET list is built only from fields the caller actually supplied, so an
   * omitted field keeps its stored value rather than being nulled — the difference
   * between a patch and a PUT. `updated_at = now()` is appended unconditionally:
   * any accepted change bumps it. A slug rename is allowed here; it is safe
   * precisely because comments key off `article_id`, not this text (D10).
   *
   * A rename onto an already-taken slug trips the unique index. Postgres gives
   * UPDATE no `on conflict` escape, so the only race-free option is to catch the
   * violation *here*, in the layer that owns SQL, and translate it to a domain
   * signal before it climbs. The `23505` stops at this boundary; the service sees
   * `'conflict'` and the client sees `SLUG_CONFLICT`.
   *
   * `published_at` is written through `coalesce`, not a plain assignment: the
   * patch carries a *candidate* first-publish timestamp and the row keeps its
   * existing one whenever it has one. Deciding "first publish?" by reading the
   * row first and assigning conditionally would be a read-after-write race — two
   * concurrent publishes would both see null and the later commit would overwrite
   * the earlier first-publish time. Under the row lock, coalesce makes the
   * "never re-stamp an existing first-publish time" rule (design §1.1) atomic
   * rather than advisory.
   */
  async updateBySlug(slug: string, patch: UpdatePatch): Promise<UpdateResult> {
    const sets: string[] = []
    const values: unknown[] = []
    const assign = (column: string, value: unknown): void => {
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }

    if (patch.slug !== undefined) assign('slug', patch.slug)
    if (patch.title !== undefined) assign('title', patch.title)
    if (patch.excerpt !== undefined) assign('excerpt', patch.excerpt)
    if (patch.contentMd !== undefined) assign('content_md', patch.contentMd)
    if (patch.category !== undefined) assign('category', patch.category)
    if (patch.tags !== undefined) assign('tags', patch.tags)
    if (patch.coverImage !== undefined) assign('cover_image', patch.coverImage)
    if (patch.readTime !== undefined) assign('read_time', patch.readTime)
    if (patch.status !== undefined) assign('status', patch.status)
    if (patch.publishedAt !== undefined) {
      values.push(patch.publishedAt)
      sets.push(`published_at = coalesce(published_at, $${values.length}::timestamptz)`)
    }

    sets.push('updated_at = now()')

    values.push(slug)
    const slugParam = `$${values.length}`

    try {
      const result = await this.pool.query<ArticleRecordRow>(
        `update articles
           set ${sets.join(',\n           ')}
         where slug = ${slugParam}
         returning ${DETAIL_COLUMNS}`,
        values,
      )

      const row = result.rows[0]
      if (row === undefined) return { kind: 'not_found' }

      return { kind: 'updated', record: toArticleRecord(row) }
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return { kind: 'conflict' }
      }
      throw error
    }
  }

  /**
   * Delete by slug. Returns whether a row was actually removed.
   *
   * Hard delete (prd known-limitation 4): comments follow via their cascade FK.
   * `false` is "nothing matched the slug", which the service renders as 404 — the
   * same answer whether the article never existed or already left, so the endpoint
   * never confirms a prior existence.
   */
  async deleteBySlug(slug: string): Promise<boolean> {
    const result = await this.pool.query(
      `delete from articles where slug = $1`,
      [slug],
    )

    return (result.rowCount ?? 0) > 0
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

/** A full article row, as `DETAIL_COLUMNS` returns it for reads and writes alike. */
interface ArticleRecordRow {
  id: string
  slug: string
  title: string
  excerpt: string
  category: string
  tags: string[]
  cover_image: string | null
  read_time: number
  published_at: Date | null
  content_md: string
  status: string
  updated_at: Date
}

function toArticleRecord(row: ArticleRecordRow): ArticleRecord {
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
    updatedAt: row.updated_at.toISOString(),
  }
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
