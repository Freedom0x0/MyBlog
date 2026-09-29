import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { requireAdmin } from '../auth/guards.js'
import { requireCsrfHeader } from '../../plugins/auth.js'
import {
  ArticleAdminSchema,
  ArticleDetailSchema,
  ArticlePageSchema,
  CreateArticleSchema,
  ListQuerySchema,
  SlugParamsSchema,
  UpdateArticleSchema,
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

  /**
   * All three writes share one onRequest hook pair, and the ordering is load-bearing.
   *
   * `requireAdmin` runs first, so an unauthenticated call gets 401 and a
   * logged-in non-admin gets 403 *before* the CSRF header is even consulted — the
   * CSRF check is the last line, not a substitute for authorisation.
   *
   * `requireCsrfHeader` is attached to PATCH and DELETE, not just POST: design §5
   * flags "CSRF only on POST" as the easy mistake, but a state-changing request is
   * state-changing whichever verb carries it, and a cross-site form can drive
   * PUT/DELETE-style requests once the token is a cookie the browser auto-attaches.
   */
  app.post(
    '/api/v1/articles',
    {
      onRequest: [requireAdmin, requireCsrfHeader],
      schema: {
        body: CreateArticleSchema,
        response: { 201: ArticleAdminSchema },
      },
    },
    async (request, reply) => reply.code(201).send(await service.create(request.body)),
  )

  app.patch(
    '/api/v1/articles/:slug',
    {
      onRequest: [requireAdmin, requireCsrfHeader],
      schema: {
        params: SlugParamsSchema,
        body: UpdateArticleSchema,
        response: { 200: ArticleAdminSchema },
      },
    },
    async (request) => service.update(request.params.slug, request.body),
  )

  app.delete(
    '/api/v1/articles/:slug',
    {
      onRequest: [requireAdmin, requireCsrfHeader],
      schema: {
        params: SlugParamsSchema,
      },
    },
    async (request, reply) => {
      await service.remove(request.params.slug)
      return reply.code(204).send()
    },
  )
}
