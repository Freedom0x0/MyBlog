import {
  ERROR_CODES,
  type AdminArticlePage,
  type ArticleAdmin,
  type ArticleDetail,
  type ArticlePage,
  type ArticleStatus,
  type CreateArticleInput,
  type ExportedArticleFile,
  type ExportedBlog,
  type ImportArticleFile,
  type ImportArticleResult,
  type ImportArticlesResponse,
  type UpdateArticleInput,
} from 'shared'
import { ApiError } from '../../errors.js'
import { FixtureError, parseFixture } from '../../db/frontmatter.js'
import { decodeCursor, encodeCursor, InvalidCursorError, type Cursor } from '../../lib/pagination.js'
import { CreateArticleSchema } from './schema.js'
import type { ArticleRecord, ArticleRepository, UpdatePatch } from './repository.js'

/**
 * Business rules. No `request`, no `reply`, no SQL — those are the boundaries this
 * layer must not know about, which is also what makes it testable with nothing but
 * a repository stand-in.
 */
/**
 * An article record that has passed the visibility check.
 *
 * Narrowing `publishedAt` into the return type is the point: without it, every
 * caller would have to re-test a field that `findPublished` already proved
 * non-null — and the type system would be silently wrong in the other direction
 * if they forgot.
 */
export type PublishedArticle = Omit<ArticleRecord, 'publishedAt'> & {
  publishedAt: string
}

export class ArticleService {
  constructor(private readonly repository: ArticleRepository) {}

  async list(input: {
    limit: number
    cursor?: string
    tag?: string
    category?: string
  }): Promise<ArticlePage> {
    const rows = await this.repository.listPublished({
      // One extra row answers "is there a next page?" without a COUNT(*).
      limit: input.limit + 1,
      cursor: input.cursor === undefined ? undefined : toCursor(input.cursor),
      tag: input.tag,
      category: input.category,
    })

    const hasMore = rows.length > input.limit
    const page = hasMore ? rows.slice(0, input.limit) : rows
    const last = page.at(-1)

    return {
      data: page.map((row) => row.summary),
      next: hasMore && last !== undefined
        ? { cursor: encodeCursor({ p: last.cursorKey, i: last.id }) }
        : null,
      limit: input.limit,
    }
  }

  /**
   * Resolve a slug to its stored record, refusing anything not publicly readable.
   *
   * This is the single home of the visibility rule. `getPublished` uses it, and
   * the comment endpoints use it too — a second copy of the same three conditions
   * somewhere else is how the two endpoints eventually disagree about what is
   * public, and only one of them starts leaking drafts.
   *
   * Missing, unpublished, and "published but with no timestamp" all answer 404.
   * A 403 would be the more informative answer and the wrong one: it confirms a
   * slug exists, which on a public endpoint lets someone enumerate unannounced
   * articles. The third condition cannot hold while the
   * `published_needs_timestamp` constraint does; it is here because this is a
   * security boundary and the safe direction for a broken assumption is "private".
   */
  async findPublished(slug: string): Promise<PublishedArticle> {
    const found = await this.repository.findBySlug(slug)

    if (found === null || found.status !== 'published' || found.publishedAt === null) {
      throw new ApiError(ERROR_CODES.articleNotFound, `No published article with slug '${slug}'`, 404)
    }

    // Spread with an explicit publishedAt: TypeScript narrows the property access
    // above but not the whole object's assignability, so `return found` would
    // still carry `publishedAt: string | null`.
    return { ...found, publishedAt: found.publishedAt }
  }

  async getPublished(slug: string): Promise<ArticleDetail> {
    const found = await this.findPublished(slug)

    return {
      slug: found.slug,
      title: found.title,
      excerpt: found.excerpt,
      category: found.category,
      tags: found.tags,
      coverImage: found.coverImage,
      readTime: found.readTime,
      publishedAt: found.publishedAt,
      content: found.contentMd,
    }
  }

  // ── admin read path (S3-R20 ~ S3-R21) ───────────────────────────────────────

  /**
   * The admin list: every status, newest change first.
   *
   * Page assembly mirrors `list()` instead of sharing a helper with it, on purpose.
   * The two agree on envelope shape (`data`/`next`/`limit`) but not on key — one
   * cursor is a `published_at`, the other an `updated_at` — and merging them into
   * one generic would let a change to admin paging reach a public response that has
   * been stable since S1. `list()` also carries a precondition this must not
   * inherit: a null `published_at` is a broken invariant there and a draft here.
   */
  async listForAdmin(input: {
    limit: number
    cursor?: string
    status?: ArticleStatus
  }): Promise<AdminArticlePage> {
    const rows = await this.repository.adminList({
      // One extra row answers "is there a next page?" without a COUNT(*).
      limit: input.limit + 1,
      cursor: input.cursor === undefined ? undefined : toCursor(input.cursor),
      status: input.status,
    })

    const hasMore = rows.length > input.limit
    const page = hasMore ? rows.slice(0, input.limit) : rows
    const last = page.at(-1)

    return {
      data: page.map((row) => row.summary),
      // Built from the row's full-precision `cursorKey`, never the millisecond
      // `updatedAt` the client sees — see `ArticleListRow.cursorKey`.
      next: hasMore && last !== undefined
        ? { cursor: encodeCursor({ p: last.cursorKey, i: last.id }) }
        : null,
      limit: input.limit,
    }
  }

  /**
   * One article by slug, whatever its status — the admin detail (S3-R21).
   *
   * No third SQL statement: `findBySlug` already promises only "whatever matched
   * this slug" and leaves visibility to the service, so this is not a second copy
   * of the visibility rule sitting next to `findPublished` — it is the absence of
   * one. `findPublished` answers "may the public see this?"; this answers "may an
   * admin?", and the answer to the second is "yes, always", reached exclusively
   * through `requireAdmin`. The public endpoint keeps returning 404 for the same
   * draft: this route opens no hole, it is the guarded door (design §1.4 refuses
   * `?includeDraft` because that would hand the request the switch).
   *
   * A slug that matches nothing answers 404 `ARTICLE_NOT_FOUND`, the same code the
   * public path uses. Nothing richer is warranted: every article in every status is
   * already readable here, so a missing row is simply a missing row.
   */
  async getForAdmin(slug: string): Promise<ArticleAdmin> {
    const found = await this.repository.findBySlug(slug)

    if (found === null) {
      throw new ApiError(ERROR_CODES.articleNotFound, `No article with slug '${slug}'`, 404)
    }

    return toArticleAdmin(found)
  }

  // ── admin export (S8-a) ─────────────────────────────────────────────────────

  /**
   * The whole blog, in every status, as one JSON document the import can read.
   *
   * **Format: one JSON document, not a tarball** — argued from the import DTO rather
   * than from taste. `POST /api/v1/articles/import` takes
   * `{ files: [{ name, markdown }] }` as a JSON body, so the export's `articles` array
   * is that same body's array field: the document is *already* in the only shape the
   * restore path consumes, and no untar-and-loop step exists to get wrong. A tar of
   * `<slug>.md` files would be the more familiar backup shape and would need either a
   * new dependency (tar has no stdlib writer) or a hand-rolled ustar writer, and then
   * the restore becomes "untar, then POST each file" — a manual step, which is exactly
   * the thing a backup endpoint is supposed to remove. JSON also survives the two
   * transports this project actually uses: FinalShell downloads it, `jq` reads it, and
   * `curl -s ... | jq '.articles[] | select(.name=="x.md") | .markdown' > x.md` is the
   * one-line single-article recovery.
   *
   * **Buffered, not streamed, and the reason is the error envelope.** If rendering or
   * serialization throws after the response has begun, the caller holds a 200 with half
   * a document — a truncated backup is the worst possible failure of this endpoint,
   * because it is only discovered at restore time, which is the moment there is no
   * other copy. Buffering means a failure is an ordinary
   * `{error:{code,message,requestId}}` and no file at all. It also keeps the response
   * inside the drift-guarded DTO: fptz serializes whole responses, so streaming would
   * mean bypassing `ExportedBlogSchema` and its guards.
   *
   * **The practical ceiling, measured on this tree rather than guessed.** Fastify's
   * default `bodyLimit` (1 MiB) governs *request* bodies only, so nothing about this
   * response is constrained by configuration. Three numbers, all from running the real
   * `renderArticleMarkdown` + `ExportedBlogSchema` encode + `JSON.stringify` path (with
   * `node --expose-gc`, against `dist/`):
   * - **Today — 7 articles, 120,506 bytes of rendered markdown → 125,159 bytes on the
   *   wire**, i.e. +3.8%. Escaping is *not* the multiplier it looks like in the import's
   *   `bodyLimit` arithmetic: `JSON.stringify` leaves non-ASCII alone, and this corpus is
   *   mostly CJK prose with few quotes per kilobyte. End-to-end response time in the
   *   suite is 10-16 ms per call.
   * - **500 articles at a realistic 5 KiB mean — 2.8 MiB of markdown, 2.8 MiB on the
   *   wire, ~3 ms encode + ~15 ms stringify, +9.4 MiB of heap.** Five hundred posts is
   *   far past what this blog holds and it costs fifteen milliseconds.
   * - **500 articles the size of `fixtures/oversized.md` — 64.8 MiB of markdown,
   *   64.9 MiB on the wire, ~330 ms of `JSON.stringify`, +203 MiB of heap.**
   *
   * So the ceiling is neither size alone nor time alone: the 65 MiB case is one
   * synchronous block on the event loop — every other in-flight request, `/health`
   * included, waits behind the backup for a third of a second — *and* a 200 MiB transient
   * in a process that also holds a `pg` pool. The realistic case is two orders of
   * magnitude under both. The condition that reopens this is a database whose article
   * text totals tens of MiB, at which point the answer is a streaming format (NDJSON, or
   * a tar written by a job) *plus* dropping the response DTO — giving up the "the file is
   * already the import body" property this endpoint exists for, which is why it is
   * recorded rather than built now.
   *
   * `exportedAt` is the one field that makes two exports of an unchanged database
   * differ, deliberately: it says when the copy was taken, which is the first thing
   * anyone wants to know about a backup. Everything below it is ordered deterministically
   * (see `listAllForExport`) so the part a person would diff stays stable.
   */
  async exportAll(): Promise<ExportedBlog> {
    const rows = await this.repository.listAllForExport()

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      articles: rows.map(toExportFile),
    }
  }

  // ── admin write path ────────────────────────────────────────────────────────

  /**
   * Create a draft.
   *
   * There is no status argument: `CreateArticleInput` carries none and the
   * repository seeds `'draft'`, so creating can never publish (S3-R0 /
   * design §1.1). A slug already taken — including by a concurrent insert that
   * won the race — surfaces as 409 SLUG_CONFLICT; the underlying `23505` was
   * swallowed by `on conflict do nothing` and never reaches the response body.
   */
  async create(input: CreateArticleInput): Promise<ArticleAdmin> {
    const created = await this.repository.insertDraft({
      slug: input.slug,
      title: input.title,
      excerpt: input.excerpt,
      contentMd: input.content,
      category: input.category,
      tags: input.tags,
      coverImage: input.coverImage ?? null,
      readTime: input.readTime ?? 5,
    })

    if (created === null) {
      throw new ApiError(
        ERROR_CODES.slugConflict,
        `An article with slug '${input.slug}' already exists`,
        409,
      )
    }

    return toArticleAdmin(created)
  }

  /**
   * Update, addressed by the article's current slug.
   *
   * This is the only entry point allowed to change `status`, and the timestamp
   * rules follow design §1.1:
   * - publishing never re-stamps an existing `published_at` — the first-publish
   *   time is preserved across later edits and re-publishes, decided by the
   *   repository's `coalesce` under the row lock, not by a racy read here;
   * - moving back to draft (or archive) leaves `published_at` untouched, so we
   *   never strand "was once published" information, and never violate the
   *   `published_needs_timestamp` invariant (that constraint forbids
   *   published-without-timestamp, never draft-with-stale-timestamp).
   *
   * The read up front exists for the 404 and the no-op return, not for the
   * timestamp decision. The 404 here is deliberate for admins: a nonexistent
   * slug answers the same way as for the public `findPublished`, so the write
   * endpoint leaks nothing about drafts beyond what the caller (an admin) is
   * already allowed to see through the admin read surface.
   */
  async update(slug: string, input: UpdateArticleInput): Promise<ArticleAdmin> {
    const existing = await this.repository.findBySlug(slug)
    if (existing === null) {
      throw new ApiError(ERROR_CODES.articleNotFound, `No article with slug '${slug}'`, 404)
    }

    const patch: UpdatePatch = {
      slug: input.slug,
      title: input.title,
      excerpt: input.excerpt,
      contentMd: input.content,
      category: input.category,
      tags: input.tags,
      coverImage: input.coverImage,
      readTime: input.readTime,
      status: input.status,
    }

    if (input.status === 'published') {
      // A *candidate* timestamp, applied by the repository with `coalesce`: the
      // row keeps its existing first-publish time even if a concurrent publish
      // stamped it after the read above. Deciding "already stamped?" here from
      // `existing.publishedAt` would be the read-after-write race every write
      // path in this module avoids by letting one statement under the row lock
      // answer the question.
      patch.publishedAt = new Date()
    }

    // Every known field absent: a no-op patch. Returning the stored record keeps
    // `updated_at` from drifting on a request that changed nothing.
    if (Object.values(patch).every((value) => value === undefined)) {
      return toArticleAdmin(existing)
    }

    const result = await this.repository.updateBySlug(slug, patch)

    if (result.kind === 'not_found') {
      // Reachable only if the row vanished between the read and the update.
      throw new ApiError(ERROR_CODES.articleNotFound, `No article with slug '${slug}'`, 404)
    }

    if (result.kind === 'conflict') {
      throw new ApiError(
        ERROR_CODES.slugConflict,
        `Another article already owns the slug '${input.slug}'`,
        409,
      )
    }

    return toArticleAdmin(result.record)
  }

  /**
   * Delete by slug. Cascade removes the article's comments (their FK is
   * `on delete cascade`), which is the whole cleanup — there is no recycle bin
   * (prd known-limitation 4).
   */
  async remove(slug: string): Promise<void> {
    const deleted = await this.repository.deleteBySlug(slug)
    if (!deleted) {
      throw new ApiError(ERROR_CODES.articleNotFound, `No article with slug '${slug}'`, 404)
    }
  }

  /**
   * Import markdown files as drafts (S3-R7 ~ S3-R11, design §3).
   *
   * Two phases, in this order, because the order *is* the requirement. Phase 1
   * parses every file and throws on the first one that fails, so a batch carrying
   * one malformed file writes zero rows (S3-R11) — there is no half-imported batch
   * to notice and clean up. Phase 2 then writes sequentially and reports per file,
   * and does NOT roll back the batch when one article conflicts: "3 of 5 landed,
   * here are the two that did not and why" beats "the batch failed, go guess which
   * file broke it" (design §3.2). Each `create()` is its own statement and
   * therefore already atomic, so no partial row is possible either.
   *
   * Everything that actually decides what lands in the table is `create()`'s: this
   * method adds no write path of its own. That is the point of parsing server-side
   * (design §3) — one door, one set of rules behind it.
   */
  async importAll(files: ImportArticleFile[]): Promise<ImportArticlesResponse> {
    // Phase 1: parse + map, all or nothing.
    const prepared = files.map((file) => toDraftInput(file))

    // Phase 2: write, collecting one result per file in the order they arrived.
    const results: ImportArticleResult[] = []

    for (const { name, input } of prepared) {
      try {
        results.push({ name, kind: 'created', article: await this.create(input) })
      } catch (error) {
        // Only a slug conflict becomes a per-file result. Anything else — a lost
        // permission check, the database being down, a constraint nobody expected
        // — is rethrown so it reaches the error handler and a 4xx/5xx that says so.
        // Catching `Error` here would dress an infrastructure failure up as a
        // business outcome and report 200 for a request the server could not serve.
        if (error instanceof ApiError && error.code === ERROR_CODES.slugConflict) {
          // `proposed` is the object this loop already built and deliberately did
          // not write, returned so "overwrite?" costs one PATCH instead of a second
          // parser in the browser (design §3.3).
          results.push({
            name,
            kind: 'conflict',
            slug: input.slug,
            message: error.message,
            proposed: input,
          })
          continue
        }
        throw error
      }
    }

    return { results }
  }
}

/**
 * A file that has become a create-and-store draft, name kept for the report.
 */
interface PreparedDraft {
  name: string
  input: CreateArticleInput
}

/**
 * Parse one imported file into a `CreateArticleInput`, or throw a 400 that names it.
 *
 * `parseFixture` is reused rather than reimplemented (S3-R8): it is the same
 * parser the seed uses, so the front-matter format has one definition — including
 * the refusals (YAML indentation, comments, unknown keys, duplicate keys, the
 * `tags: [a, b]` form). A second, more forgiving parser in the import path would
 * accept exactly the files the seed rejects and then be blamed for the difference.
 *
 * It lives under `src/db/`, which makes an import from a service look like a
 * layering break. It is not one: the rule in architecture §1 is that a service
 * must not speak HTTP or SQL, and this is a pure text → object function with no
 * pool, no request and no driver. Moving it out of `db/` would drag `seed.ts` and
 * `frontmatter.test.ts` along for a cosmetic win, so it stays where it is.
 *
 * `fixture.status` and `fixture.publishedAt` are deliberately dropped here. An
 * import always lands a draft (S3-R9), and no new code is needed to guarantee
 * that: `CreateArticleInput` has no `status` field and the repository hard-wires
 * `'draft'`, so a published-looking file has nowhere to put it. `status` still
 * participates in validation — it is a required key and its value is checked, so
 * `status: published` is accepted *as text* and then ignored, never honoured.
 */
function toDraftInput(file: ImportArticleFile): PreparedDraft {
  let fixture
  try {
    // The file name is passed as the parse source so the parser's own messages
    // say which file it is talking about. It is *only* ever an identifier: it
    // never reaches SQL (the repository binds values, builds no statements from
    // them) and never reaches a filesystem path (nothing here touches disk).
    fixture = parseFixture(file.markdown, file.name)
  } catch (error) {
    if (error instanceof FixtureError) {
      // The parser's message already starts with the file name. Forwarding the
      // exception itself would hand the client a stack; this is a plain 400 in the
      // shared envelope with `code: BAD_REQUEST` (design §6).
      throw new ApiError(ERROR_CODES.badRequest, `Cannot import ${error.message}`, 400)
    }
    throw error
  }

  const candidate: CreateArticleInput = {
    slug: fixture.slug,
    title: fixture.title,
    excerpt: fixture.excerpt,
    content: fixture.body,
    category: fixture.category,
    tags: fixture.tags,
    coverImage: fixture.coverImage,
    readTime: fixture.readTime,
  }

  // Cross-check the mapped draft against `CreateArticleSchema` — the *same* DTO
  // `POST /api/v1/articles` validates with. Without it, import would be a side door
  // around those field bounds: the front-matter parser checks the *shape* of the
  // block (keys, status vocabulary, the tag list form) but not the article's field
  // sizes, so `excerpt:` or a body-less file parses fine and would be written as-is
  // while the create endpoint refuses it. Reusing the existing DTO keeps the bounds
  // in one place instead of inventing a second set here.
  const validated = CreateArticleSchema.safeParse(candidate)
  if (!validated.success) {
    const reasons = validated.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new ApiError(ERROR_CODES.badRequest, `Cannot import ${file.name}: ${reasons}`, 400)
  }

  return { name: file.name, input: validated.data }
}

/**
 * The downloaded file's name prefix, kept separate so the shape of the name has one
 * definition — see `buildExportFilename` for what may and may not be interpolated
 * into it.
 */
export const EXPORT_FILENAME_PREFIX = 'myblog-export-'

/**
 * Front-matter timestamp: ISO-8601 in UTC, with a whole second written as a whole
 * second.
 *
 * `2026-09-20T10:00:00.000Z` and `2026-09-20T10:00:00Z` name the same instant and
 * `parseFixture` accepts both (it stores the text and the import then ignores it), so
 * nothing here is about validity. It is about the exported file being diffable against
 * the local `.md` originals — which is the reason the export format was chosen to match
 * `fixtures/*.md` byte for byte. Only a *zero* millisecond part is trimmed, so a publish
 * stamped by `now()` keeps its `.595Z` rather than being silently rounded away.
 */
function formatFrontMatterTimestamp(iso: string): string {
  return iso.replace(/\.000Z$/, 'Z')
}

/**
 * Render one stored article back into the markdown file it came from.
 *
 * **The format is `parseFixture`'s, because that function is the only reader this
 * output has to satisfy** — `POST /api/v1/articles/import` parses with it and nothing
 * else. Key order, the flat `key: value` lines, the `tags: [a, b]` form and the
 * trailing `publishedAt` are copied from `fixtures/*.md` deliberately, and the export
 * test asserts the result is byte-identical to those seven files. If this ever stops
 * matching, the export stops being restorable through the project's own writer, which
 * is the failure this whole endpoint exists to prevent.
 *
 * What is emitted, and what is pointedly not:
 * - `status` and `publishedAt` **are** written even though an import cannot honour
 *   them (`toDraftInput` drops both; import always lands a draft — S3-R9). Dropping
 *   `status` is not an option, it is a *required* key of the format. Writing the true
 *   value anyway is what makes the file a record rather than a draft-maker: a person
 *   restoring by hand can see which articles were published and when, and re-publish
 *   them with a `PATCH` per slug. The automated path does not read them, and the
 *   route's comment states that out loud rather than leaving it to be inferred.
 * - `updatedAt`, `id` and `views` are **not** written, and cannot be: `ALLOWED_KEYS`
 *   in `db/frontmatter.ts` is a closed set and an unknown key is a hard
 *   `FixtureError` — one extra line here would make *every* exported file
 *   unimportable. `updatedAt` is the tempting one ("a backup should keep timestamps!")
 *   and it is the trap. What is lost is the modification time only: `created_at` was
 *   never readable through this API at all, and `updated_at` is re-set by the write
 *   itself.
 * - `coverImage` is omitted when null, matching the fixtures. `parseFixture` maps both
 *   an absent key and the literal `null` to `null`, so the omission round-trips.
 *
 * Known fidelity limits, all of them properties of the flat format rather than of this
 * function (each is pinned by a test in `articles-export.test.ts`):
 * - a value containing a newline or leading/trailing whitespace cannot survive it —
 *   the parser splits on the first `:` and trims, and a wrapped line is then "not a
 *   'key: value' line". `CreateArticleSchema` bounds lengths but not characters, so a
 *   `PATCH` can put a newline in a title and the export of that article re-imports as a
 *   400. The value is written verbatim rather than escaped or altered: silently
 *   rewriting a title would make the backup lie about what it holds.
 * - a tag containing a comma re-reads as two tags, and brackets or a leading/trailing
 *   space in any value shift it likewise.
 * - a body starting with a newline loses exactly one of them, because the parser
 *   strips a single leading newline after the closing delimiter.
 * - a slug containing `/` or `\` produces a `name` the import's DTO refuses, and a slug
 *   with a newline breaks the front-matter. Slug shape is not constrained by the write
 *   DTO (only length), so this is a gap in the *write* rules, not something the export
 *   can paper over.
 */
export function renderArticleMarkdown(record: ArticleRecord): string {
  // Order = the fixtures' order. `content_md` is the body, not a key, so it is the
  // part after the closing delimiter.
  const lines = [
    `slug: ${record.slug}`,
    `title: ${record.title}`,
    `excerpt: ${record.excerpt}`,
    `category: ${record.category}`,
    `tags: [${record.tags.join(', ')}]`,
  ]

  // Optional in the fixtures and optional here, in the column order the table itself
  // uses (cover_image sits between tags and read_time): `parseFixture` maps an absent
  // key and the literal `null` to the same `null`, so omitting a missing cover image
  // round-trips and keeps the file shaped like the originals.
  if (record.coverImage !== null) {
    lines.push(`coverImage: ${record.coverImage}`)
  }

  lines.push(`readTime: ${record.readTime}`, `status: ${record.status}`)

  // Trailing in the fixtures, so trailing here — and absent for a draft, which has no
  // publication time to write (`publishedAt: null` would parse the same but claims
  // something the row does not hold).
  if (record.publishedAt !== null) {
    lines.push(`publishedAt: ${formatFrontMatterTimestamp(record.publishedAt)}`)
  }

  // The body is appended byte-for-byte: no re-wrapping, no added or stripped trailing
  // newline. `parseFixture` produced it from exactly this shape on the way in.
  return `---\n${lines.join('\n')}\n---\n${record.contentMd}`
}

/**
 * One stored article as one importable file.
 *
 * `name` is `<slug>.md` — the filename the person would have on disk, and the value
 * the import pairs with its own `proposed`/conflict reporting. It is derived from a
 * column that a write did fill from a request (`slug` is `CreateArticleInput.slug`), so
 * it is not a secret-named server artefact; but it is also *only* ever an identifier
 * here — nothing in the export path touches a filesystem with it, and the download's own
 * filename comes from `buildExportFilename`, never from this string.
 */
function toExportFile(record: ArticleRecord): ExportedArticleFile {
  return { name: `${record.slug}.md`, markdown: renderArticleMarkdown(record) }
}

/**
 * `myblog-export-2026-10-08.json` — the name the browser saves the download as.
 *
 * Every character comes from the server's clock, and nothing comes from the request.
 * That is the standing rule of this repository for anything that names a thing: the
 * upload path issues `uploads/<utc-year>/<utc-month>/<random hex>.<sniffed extension>`
 * (`buildUploadKey` in `modules/uploads/s3-store.ts`) and refuses to let a declared
 * content type or filename choose a key or a path. Here the risk is lower — the string
 * goes into a `Content-Disposition` header and thence to a *download* name, never to a
 * path on the server — but a header value is still a string another machine will
 * interpret, and the shape of the mistake is the same: user text becoming an identifier.
 * A caller-controlled export name would also be a way to make a browser save over the
 * operator's previous backup.
 *
 * UTC rather than the process's local zone, so the name does not depend on how the
 * container's `TZ` happens to be set — the same choice `buildUploadKey` makes, and the
 * reason it writes the month with `padStart(2, '0')` instead of using `toLocaleDateString`
 * (a locale-dependent name is one nobody can script against). Because the alphabet is
 * `[a-z0-9.-]` only, no RFC 5987 `filename*=` form is needed and none is emitted.
 */
export function buildExportFilename(now: Date): string {
  const year = now.getUTCFullYear().toString().padStart(4, '0')
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  const day = String(now.getUTCDate()).padStart(2, '0')

  return `${EXPORT_FILENAME_PREFIX}${year}-${month}-${day}.json`
}

function toArticleAdmin(record: ArticleRecord): ArticleAdmin {
  return {
    slug: record.slug,
    title: record.title,
    excerpt: record.excerpt,
    category: record.category,
    tags: record.tags,
    coverImage: record.coverImage,
    readTime: record.readTime,
    publishedAt: record.publishedAt,
    content: record.contentMd,
    status: record.status,
    updatedAt: record.updatedAt,
  }
}

function toCursor(raw: string): Cursor {
  try {
    return decodeCursor(raw)
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      throw new ApiError(ERROR_CODES.invalidCursor, error.message, 400)
    }
    throw error
  }
}
