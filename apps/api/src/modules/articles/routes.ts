import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import {
  ArticleDetailSchema,
  ArticlePageSchema,
  ListQuerySchema,
  SlugParamsSchema,
} from './schema.js'
import { ArticleRepository } from './repository.js'
import { ArticleService } from './service.js'

/**
 * HTTP boundary only: parse, validate, call the service, serialize.
 *
 * No business rule belongs here, and no error response is built here either —
 * the service throws and `plugins/errorHandler` formats, which is what keeps the
 * envelope in one place instead of N places.
 */
export const articleRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new ArticleService(new ArticleRepository(app.db))

  app.get(
    '/api/v1/articles',
    {
      schema: {
        querystring: ListQuerySchema,
        response: { 200: ArticlePageSchema },
      },
    },
    async (request) => service.list(request.query),
  )

  app.get(
    '/api/v1/articles/:slug',
    {
      schema: {
        params: SlugParamsSchema,
        response: { 200: ArticleDetailSchema },
      },
    },
    async (request) => service.getPublished(request.params.slug),
  )
}
