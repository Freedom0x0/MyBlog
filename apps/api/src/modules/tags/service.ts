import type { ArticlePage, TagList } from 'shared'
import type { ArticleService } from '../articles/service.js'
import type { TagRepository } from './repository.js'

export interface TagListOptions {
  limit: number
  cursor?: string
}

export class TagService {
  constructor(
    private readonly tags: TagRepository,
    private readonly articles: ArticleService,
  ) {}

  async list(): Promise<TagList> {
    return { data: await this.tags.listWithCounts() }
  }

  /**
   * Delegates to the article list rather than querying again.
   *
   * `/tags/:tag` is the same paginated read with one filter preset, so routing it
   * through `ArticleService.list` keeps the draft rule, the keyset cursor and the
   * limit bounds in one place. A second implementation would have been free to
   * drift from the first.
   */
  async articlesByTag(tag: string, options: TagListOptions): Promise<ArticlePage> {
    return this.articles.list({ limit: options.limit, cursor: options.cursor, tag })
  }
}
