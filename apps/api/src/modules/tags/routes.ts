import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { ArticleRepository } from '../articles/repository.js'
import { ArticleService } from '../articles/service.js'
import { ArticlePageSchema, ListQuerySchema } from '../articles/schema.js'
import { TagRepository } from './repository.js'
import { TagService } from './service.js'
import { TagListSchema, TagParamsSchema } from './schema.js'

export const tagRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new TagService(
    new TagRepository(app.db),
    new ArticleService(new ArticleRepository(app.db)),
  )

  app.get(
    '/api/v1/tags',
    { schema: { response: { 200: TagListSchema } } },
    async () => service.list(),
  )

  app.get(
    '/api/v1/tags/:tag',
    {
      // The article list's query schema is reused verbatim, so the limit bounds and
      // cursor rules cannot drift out of sync with the endpoint this mirrors.
      schema: {
        params: TagParamsSchema,
        querystring: ListQuerySchema,
        response: { 200: ArticlePageSchema },
      },
    },
    async (request) =>
      // The path parameter wins over any `?tag=` so a client cannot widen the
      // filter it claimed to request.
      service.articlesByTag(request.params.tag, request.query),
  )
}
