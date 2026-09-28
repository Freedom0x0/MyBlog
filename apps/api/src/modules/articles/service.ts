import { ERROR_CODES, type ArticleDetail, type ArticlePage } from 'shared'
import { ApiError } from '../../errors.js'
import { decodeCursor, encodeCursor, InvalidCursorError, type Cursor } from '../../lib/pagination.js'
import type { ArticleRepository } from './repository.js'

/**
 * Business rules. No `request`, no `reply`, no SQL — those are the boundaries this
 * layer must not know about, which is also what makes it testable with nothing but
 * a repository stand-in.
 */
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

  async getPublished(slug: string): Promise<ArticleDetail> {
    const found = await this.repository.findBySlug(slug)

    /**
     * Missing, unpublished, and "published but with no timestamp" all answer 404.
     *
     * A 403 for drafts would be the more informative answer and the wrong one: it
     * confirms a slug exists, which on a public endpoint is a leak — someone could
     * enumerate unannounced articles.
     *
     * The third condition cannot happen while the `published_needs_timestamp`
     * constraint holds; it is here because this is a security boundary, and the
     * safe direction for a broken assumption is "not public".
     */
    if (found === null || found.status !== 'published' || found.publishedAt === null) {
      throw new ApiError(ERROR_CODES.articleNotFound, `No published article with slug '${slug}'`, 404)
    }

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
