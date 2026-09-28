import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { ArticleRepository } from '../articles/repository.js'
import { ArticleService } from '../articles/service.js'
import { CommentRepository } from './repository.js'
import { CommentService } from './service.js'
import { CommentListSchema, SlugParamsSchema } from './schema.js'

export const commentRoutes: FastifyPluginAsyncZod = async (app) => {
  // Both services wrap the same pooled `app.db`, so a second instance costs a
  // constructor call, not a connection.
  const service = new CommentService(
    new CommentRepository(app.db),
    new ArticleService(new ArticleRepository(app.db)),
  )

  app.get(
    '/api/v1/articles/:slug/comments',
    {
      schema: {
        params: SlugParamsSchema,
        response: { 200: CommentListSchema },
      },
    },
    async (request) => service.listForSlug(request.params.slug),
  )
}
