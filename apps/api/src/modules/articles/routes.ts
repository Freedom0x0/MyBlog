import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { requireAdmin } from '../auth/guards.js'
import { requireCsrfHeader } from '../../plugins/auth.js'
import { requireWriteRateLimit } from '../../plugins/rateLimit.js'
import {
  AdminArticlePageSchema,
  AdminListQuerySchema,
  ArticleAdminSchema,
  ArticleDetailSchema,
  ArticlePageSchema,
  CreateArticleSchema,
  IMPORT_BODY_LIMIT_BYTES,
  ImportArticlesResponseSchema,
  ImportArticlesSchema,
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
   * Admin reads (S3-R20 ~ S3-R21, design §1.4).
   *
   * `requireAdmin` only, with **no** `requireCsrfHeader` — the deliberate
   * asymmetry with the four writes below. CSRF protection exists because a
   * cross-site page can make a request that *changes state*; a read under an
   * authorisation check has nothing to forge, and demanding the header would only
   * add failures that mean nothing: a typed-in URL, a top-level browser navigation,
   * a read-only deep link into the admin page — none of which can set a custom
   * header, and none of which would harm anything. The authorisation is the guard;
   * the header on a GET is noise on top of it, and noise a future reader would have
   * to reverse-engineer a reason for.
   *
   * These are the only routes that serve drafts. That is carried entirely by
   * `requireAdmin`: the same hook, in the same first position, as the writes below,
   * so a logged-in non-admin gets 403 here exactly as they do on `PATCH`.
   */
  app.get(
    '/api/v1/admin/articles',
    {
      onRequest: [requireAdmin],
      schema: {
        querystring: AdminListQuerySchema,
        response: { 200: AdminArticlePageSchema },
      },
    },
    async (request) => service.listForAdmin(request.query),
  )

  app.get(
    '/api/v1/admin/articles/:slug',
    {
      onRequest: [requireAdmin],
      schema: {
        params: SlugParamsSchema,
        response: { 200: ArticleAdminSchema },
      },
    },
    async (request) => service.getForAdmin(request.params.slug),
  )

  /**
   * All four writes share one onRequest triple, and the ordering is load-bearing.
   *
   * `requireAdmin` runs first, so an unauthenticated call gets 401 and a
   * logged-in non-admin gets 403 *before* the CSRF header is even consulted — the
   * CSRF check is not a substitute for authorisation.
   *
   * `requireCsrfHeader` is attached to PATCH and DELETE, not just POST: design §5
   * flags "CSRF only on POST" as the easy mistake, but a state-changing request is
   * state-changing whichever verb carries it, and a cross-site form can drive
   * PUT/DELETE-style requests once the token is a cookie the browser auto-attaches.
   *
   * `requireWriteRateLimit` is last, and that position is chosen rather than
   * default: it needs `request.auth`, which only the guard ahead of it fills in
   * (S6-R2), and it should not spend a caller's quota on a request that was going
   * to be refused for free two hooks earlier. A 401 or a CSRF 403 therefore costs
   * the limiter nothing; only a request that was really going to write is counted.
   */
  app.post(
    '/api/v1/articles',
    {
      onRequest: [requireAdmin, requireCsrfHeader, requireWriteRateLimit],
      schema: {
        body: CreateArticleSchema,
        response: { 201: ArticleAdminSchema },
      },
    },
    async (request, reply) => reply.code(201).send(await service.create(request.body)),
  )

  /**
   * Markdown import, same guard pair and same order as the other writes.
   *
   * Answers **200** for a batch that was accepted even when some of its files
   * conflicted (design §6): the HTTP status describes the request, and a 409 here
   * would contradict the drafts this call did create. Per-file truth lives in
   * `results`, where a conflict is data with a name attached, not a status code.
   *
   * `bodyLimit` is a route-level option, so only this endpoint accepts the larger
   * body — see `IMPORT_BODY_LIMIT_BYTES` in schema.ts for why it must stay well
   * above the DTO's ceilings, and why the DTO is the one that should be answering.
   */
  app.post(
    '/api/v1/articles/import',
    {
      onRequest: [requireAdmin, requireCsrfHeader, requireWriteRateLimit],
      bodyLimit: IMPORT_BODY_LIMIT_BYTES,
      schema: {
        body: ImportArticlesSchema,
        response: { 200: ImportArticlesResponseSchema },
      },
    },
    async (request) => service.importAll(request.body.files),
  )

  app.patch(
    '/api/v1/articles/:slug',
    {
      onRequest: [requireAdmin, requireCsrfHeader, requireWriteRateLimit],
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
      onRequest: [requireAdmin, requireCsrfHeader, requireWriteRateLimit],
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
