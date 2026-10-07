import {
  ERROR_CODES,
  type AdminArticlePage,
  type ArticleAdmin,
  type ArticleDetail,
  type ArticlePage,
  type ArticleStatus,
  type CreateArticleInput,
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
