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
  ExportedBlogSchema,
  IMPORT_BODY_LIMIT_BYTES,
  ImportArticlesResponseSchema,
  ImportArticlesSchema,
  ListQuerySchema,
  SlugParamsSchema,
  UpdateArticleSchema,
} from './schema.js'
import { ArticleRepository } from './repository.js'
import { ArticleService, buildExportFilename } from './service.js'

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
   * These were the only routes that serve drafts until S8-a added the export below;
   * the same rule covers it. That is carried entirely by `requireAdmin`: the same
   * hook, in the same first position, as the writes below, so a logged-in non-admin
   * gets 403 here exactly as they do on `PATCH`.
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

  /**
   * The way out: `GET /api/v1/admin/articles/export` (S8-a).
   *
   * Pairs with the import below, and the format is *its* format — see
   * `ArticleService.exportAll` for the document and the size reasoning. The reason
   * this endpoint exists at all is recorded in the stage notes: since S3 the database
   * is the only copy of the writing (the Supabase content was discarded on purpose),
   * and the import path was one-way. A store you can only write into is not a store
   * anyone can migrate off, back up, or recover.
   *
   * **Guards: `requireAdmin` alone** — no CSRF header, no rate limiter — and both
   * omissions are the same argument the two admin reads above already make, extended:
   *
   * - CSRF protects against a cross-site request that *changes state*. This writes
   *   nothing (proved by a test that counts rows before and after, plus the control
   *   that makes the counter honest), so there is nothing to forge, and demanding a
   *   custom header would break exactly the callers that make this endpoint useful:
   *   a top-level browser navigation, a hand-typed URL, a `curl` run from FinalShell.
   *   The authorisation is the guard.
   * - The **write** rate limiter (`requireWriteRateLimit`, 60/min per identity) is
   *   deliberately not attached, and not only because a GET is not a write. Its
   *   bucket counts the operations that mutate, and the two moments someone exports
   *   are the two moments that bucket is busiest: right before a bulk import (which
   *   is 20 writes) and right after something went wrong and they want a copy of
   *   everything. Spending a quota on a read would refuse the backup, which is the
   *   one thing a backup endpoint must never do.
   *
   * What that leaves unbounded is the honest trade: this is the widest read in the API
   * — the whole `articles` table, every status, with bodies — behind one guard. The
   * ceiling it does have is the guard itself: `requireAdmin` re-reads `users.is_admin`
   * from the database on every call (`modules/auth/guards.ts`), in `onRequest`, so a
   * non-admin is refused before the handler runs and nothing is read at all, and a
   * revoked admin stops working on the next request rather than at token expiry. If it
   * ever needs a bucket of its own it should be a *read* bucket with its own key and
   * its own number — not the write bucket, whose limit is set for writes.
   *
   * **The filename is generated here, from the server clock.** `buildExportFilename`
   * takes a `Date` and interpolates digits; no part of it comes from a header, a query
   * parameter or an article's slug. This repository has a standing rule about
   * user-controlled names reaching a key or a path (`buildUploadKey` in the uploads
   * module), and a download name is the same mistake one level down: an attacker-chosen
   * `Content-Disposition` is how a backup gets saved over the previous backup.
   *
   * Registered *before* `/api/v1/admin/articles/:slug` and not after it. find-my-way
   * prefers a static segment over a parametric one regardless of insertion order, so
   * `/export` wins either way; writing it first is what makes that visible to a reader
   * instead of leaving it to a fact about the router. The consequence is unavoidable
   * with this URL and is worth naming: an article whose slug is literally `export`
   * cannot be opened at `/api/v1/admin/articles/export` — the export endpoint shadows
   * it, and `GET /api/v1/articles/export` (the public detail, a different prefix) still
   * serves it. Pinned by a test so that if the path ever moves, the test says so.
   */
  app.get(
    '/api/v1/admin/articles/export',
    {
      onRequest: [requireAdmin],
      schema: {
        response: { 200: ExportedBlogSchema },
      },
    },
    async (_request, reply) => {
      const doc = await service.exportAll()

      // Set on the reply, payload returned: the envelope, the serializer and the error
      // path all stay Fastify's, and this route adds one header rather than a second
      // way of writing a response.
      reply.header('content-disposition', `attachment; filename="${buildExportFilename(new Date())}"`)

      return doc
    },
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
