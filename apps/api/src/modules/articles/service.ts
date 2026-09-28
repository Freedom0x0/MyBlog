import { ERROR_CODES, type ArticleDetail, type ArticlePage } from 'shared'
import { ApiError } from '../../errors.js'
import { decodeCursor, encodeCursor, InvalidCursorError, type Cursor } from '../../lib/pagination.js'
import type { ArticleRepository, ArticleRecord } from './repository.js'

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
