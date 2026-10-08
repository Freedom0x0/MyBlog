import type { Pool } from 'pg'
import type { AdminArticleSummary, ArticleStatus, ArticleSummary } from 'shared'
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

/**
 * Columns for the admin list: the public list's set plus `status` and the raw
 * `updated_at`, and — like the public list — no `content_md`.
 *
 * The cursor key is `updated_at` rather than `published_at` because that is the
 * column this query orders by, and a keyset cursor must be the sort key. It is
 * spelled out with `to_char` at microsecond precision for exactly the reason
 * `LIST_COLUMNS` documents above: the payload's ISO string is millisecond-only,
 * and a keyset bound truncated below the row it came from repeats that row on the
 * next page.
 */
const ADMIN_LIST_COLUMNS = `
  id, slug, title, excerpt, category, tags, cover_image, read_time,
  published_at, status, updated_at,
  to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_key
`

/**
 * Columns for the export: `DETAIL_COLUMNS` used verbatim, because an article's
 * backup has to carry the body plus the whole front-matter set — which is exactly
 * what the detail projection already is. A fourth column list here would be a fourth
 * thing to keep in step with the table for no difference in content.
 *
 * Rows come back as `ArticleRecord`, the row type this repository already has. `id`
 * and `updatedAt` travel along and are simply not rendered into the markdown; see
 * `renderArticleMarkdown` in service.ts for why `updatedAt` in particular must not
 * be.
 */
const EXPORT_COLUMNS = DETAIL_COLUMNS

export interface ListParams {
  /** Ask for one more than the page size — see `listPublished`. */
  limit: number
  cursor?: Cursor
  tag?: string
  category?: string
}

/** Parameters for {@link ArticleRepository.adminList}. */
export interface AdminListParams {
  /** Ask for one more than the page size — see `listPublished`. */
  limit: number
  cursor?: Cursor
  /**
   * Narrow to one status. Absent means *every* status, which is the endpoint's
   * default and the whole reason it exists. The value arrives already checked
   * against the enum by `AdminListQuerySchema`, so an out-of-vocabulary string
   * cannot come back as this method returning an empty page and be mistaken for
   * "there are no such articles".
   */
  status?: ArticleStatus
}

/** A row as the admin list query returns it, before pagination decisions are made. */
export interface AdminListRow {
  /** Internal id: the keyset tie-breaker. Never exposed in a response. */
  id: string
  /**
   * Full-precision UTC text of `updated_at`, used only to build a cursor — see
   * `ArticleListRow.cursorKey` for why the wire value is not good enough.
   */
  cursorKey: string
  summary: AdminArticleSummary
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
   * The most-recently-changed page, in every status (S3-R20, design §1.4).
   *
   * A separate statement rather than a `includeDrafts` flag on `listPublished`,
   * for the reason that method's own comment gives: `listPublished` is named for
   * `status = 'published'`, and making it optionally return drafts would be a lie
   * at the boundary that every later caller has to re-derive. It would also be the
   * wrong order — the public keyset sorts on `published_at`, where every draft
   * shares one NULL sort key and lands in a uuid-ordered heap at the tail. That is
   * no order at all for exactly the rows this endpoint exists to find, which is
   * why ordering by "last changed" is a requirement (S3-R20) and not a preference.
   *
   * `updated_at`, not `created_at`: editing a week-old draft has to bring it back
   * to the top of the list, because "the thing I was just working on" is what the
   * admin page is for.
   *
   * The order needs no `NULLS` modifier — the column is `not null` (0001:40), so
   * neither `nulls first` nor `nulls last` can change a row's position. Writing
   * `nulls last` here anyway would be a claim about the data that nothing enforces.
   *
   * No index backs this scan yet. That is a recorded decision, not an oversight:
   * design §1.4 states the cost, why it is acceptable at blog scale, and the
   * condition that reopens it (a visibly slow list page, then an index whose
   * `ORDER BY` is matched to it verbatim and *proved* with `EXPLAIN` against a
   * few-thousand-row table, per conventions §9 — not against this one).
   *
   * Rows are fetched `limit + 1`, as in `listPublished`: the extra row answers
   * "is there a next page?" without a `COUNT(*)` per page.
   */
  async adminList(params: AdminListParams): Promise<AdminListRow[]> {
    // `true` as the base keeps the AND-join below valid when neither filter is
    // present — the admin list's default is all statuses, so an empty predicate
    // list is the normal case, not an edge one. The planner folds the constant
    // away; there is no index here to confuse.
    const conditions: string[] = ['true']
    const values: unknown[] = []
    const param = (): string => `$${values.length + 1}`

    if (params.status !== undefined) {
      conditions.push(`status = ${param()}`)
      values.push(params.status)
    }

    if (params.cursor !== undefined) {
      // Placeholders numbered explicitly, for the reason spelled out in
      // `listPublished`: `param()` twice inside one template string, before the
      // pushes, produces the same number twice and Postgres then tries to cast one
      // value to two types.
      const timeParam = `$${values.length + 1}`
      const idParam = `$${values.length + 2}`
      values.push(params.cursor.p, params.cursor.i)

      // Row-value comparison against the *sort key*, `(updated_at, id)`, in the
      // same descending direction the ORDER BY establishes. This is the one place
      // the two lists genuinely differ: same mechanism, different key.
      conditions.push(`(updated_at, id) < (${timeParam}::timestamptz, ${idParam}::uuid)`)
    }

    values.push(params.limit)
    const limitParam = `$${values.length}`

    const result = await this.pool.query<AdminListSourceRow>(
      `select ${ADMIN_LIST_COLUMNS}
         from articles
         where ${conditions.join('\n           and ')}
         order by updated_at desc, id desc
         limit ${limitParam}`,
      values,
    )

    return result.rows.map(toAdminListRow)
  }

  /**
   * Every article, in every status, whole: the export's single statement (S8-a).
   *
   * **No `where` clause, and that absence is the whole point.** The two list
   * statements above either filter to `status = 'published'` or narrow to one
   * status on request; a backup that reused either would silently omit the writing
   * that has not been published yet, which is exactly the content a person would
   * most hate to lose — it exists nowhere else, since the database became the only
   * copy of the writing when the Supabase content was discarded. Drafts and archived
   * rows are therefore included unconditionally rather than by a flag: an argument
   * an operator could get wrong is a worse design than an argument that cannot be
   * made.
   *
   * **No `limit`.** This reads the entire table by design; the ceiling and its cost
   * are answered in `routes.ts` next to the response, not here.
   *
   * The `order by` is what makes two exports of an unchanged database produce the
   * same sequence, and every part of it earns its place:
   * - `published_at desc` puts the newest writing first, which reads correctly in a
   *   downloaded file and in `jq`. Deliberately *not* the admin list's
   *   `updated_at`: that key moves every time the editor saves, so an export taken
   *   after a no-op edit would shuffle the whole file. Sorting on a key that only
   *   changes when the writing changes is what keeps a diff of two backups readable.
   * - `nulls last` because Postgres defaults `desc` to *nulls first*, which would
   *     park every never-published article at the top of the backup. Determinism
   *     would survive either way (the `slug` tie-break below settles the NULL group),
   *     so this half is about legibility and about matching the convention the public
   *     list and `articles_list_keyset` already use.
   * - `slug` as the tie-breaker, and it is a *total* order: `slug` is
   *   `not null unique`, so no two rows can tie on it and no row's position can ever
   *     depend on disk layout or on a page boundary. A uuid tie-breaker would also be
   *     deterministic, but a random one makes the file's order meaningless to a human
   *     reading a diff. Renaming a slug moves that entry in the backup — correct,
   *     because a rename is an edit and should show up.
   *
   * No index serves this order, stated rather than discovered later (conventions §9
   * forbids claiming one without proving it): `articles_list_keyset` is
   * `(status, published_at desc nulls last, id desc)`, and with `status` unconstrained
   * the leading column cannot be matched, so the planner will do a seq scan plus a
   * sort. At blog scale that is the cheapest correct answer — the whole table is read
   * into memory by this request anyway — and the condition that reopens it is the same
   * one the admin list records: a visibly slow response at a few thousand rows, at
   * which point `create index articles_export_order on articles (published_at desc
   * nulls last, slug)` is the candidate to prove with `EXPLAIN`, not to assume.
   */
  async listAllForExport(): Promise<ArticleRecord[]> {
    const result = await this.pool.query<ArticleRecordRow>(
      `select ${EXPORT_COLUMNS}
         from articles
        order by published_at desc nulls last, slug`,
    )

    return result.rows.map(toArticleRecord)
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

/** A row as `ADMIN_LIST_COLUMNS` returns it — the admin list's projection. */
interface AdminListSourceRow {
  id: string
  slug: string
  title: string
  excerpt: string
  category: string
  tags: string[]
  cover_image: string | null
  read_time: number
  published_at: Date | null
  status: string
  updated_at: Date
  cursor_key: string
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

/**
 * Map an admin list row.
 *
 * The counterpart to `toListRow`, and deliberately without its precondition: a
 * null `published_at` there means the database broke its own invariant, while here
 * it is simply a row that has never been published. Throwing on it would make the
 * endpoint unable to list drafts — the one thing it exists for.
 *
 * No `content` key, because no `content_md` column: the response shape is decided
 * by the projection, not by remembering to delete a field afterwards.
 */
function toAdminListRow(row: AdminListSourceRow): AdminListRow {
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
      publishedAt: row.published_at === null ? null : row.published_at.toISOString(),
      status: row.status,
      updatedAt: row.updated_at.toISOString(),
    },
  }
}
