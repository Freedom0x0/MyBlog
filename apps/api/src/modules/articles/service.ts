import {
  ERROR_CODES,
  type ArticleAdmin,
  type ArticleDetail,
  type ArticlePage,
  type CreateArticleInput,
  type UpdateArticleInput,
} from 'shared'
import { ApiError } from '../../errors.js'
import { decodeCursor, encodeCursor, InvalidCursorError, type Cursor } from '../../lib/pagination.js'
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
      // `existing.publishedAt` would re-introduce exactly the read-after-write
      // race the publish pipeline avoids with `is distinct from` (design §3.1).
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
