import type { CommentList } from 'shared'
import type { ArticleService } from '../articles/service.js'
import type { CommentRepository } from './repository.js'

export class CommentService {
  constructor(
    private readonly comments: CommentRepository,
    private readonly articles: ArticleService,
  ) {}

  async listForSlug(slug: string): Promise<CommentList> {
    /**
     * Resolved through the article service rather than re-checking status here.
     *
     * This is why `findPublished` exists as a separate method: the visibility rule
     * has one home, so this endpoint cannot drift out of agreement with the
     * article endpoint about what counts as public. A copied condition would have
     * been one edit away from leaking comments on unpublished articles.
     */
    const article = await this.articles.findPublished(slug)

    return { data: await this.comments.listForArticle(article.id) }
  }
}
