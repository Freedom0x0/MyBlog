import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { requireAuth, requireCsrfHeader } from '../../plugins/auth.js'
import { AuthRepository } from '../auth/repository.js'
import { ArticleRepository } from '../articles/repository.js'
import { ArticleService } from '../articles/service.js'
import { CommentRepository } from './repository.js'
import { CommentService } from './service.js'
import {
  CommentIdParamsSchema,
  CommentListSchema,
  CommentNodeSchema,
  CreateCommentSchema,
  SlugParamsSchema,
} from './schema.js'

export const commentRoutes: FastifyPluginAsyncZod = async (app) => {
  // Both services wrap the same pooled `app.db`, so a second instance costs a
  // constructor call, not a connection.
  //
  // The admin test reaches `users.is_admin` through `AuthRepository` — the same
  // read `requireAdmin` makes — but is handed to the service as one narrow function
  // instead of the repository object: the delete rule needs a yes/no about the
  // requester, and binding it this way keeps `setAdmin` out of the comment module's
  // reach. The arrow keeps the receiver intact, which destructuring
  // `const { isAdmin } = auth` would not.
  const auth = new AuthRepository(app.db)
  const service = new CommentService(
    new CommentRepository(app.db),
    new ArticleService(new ArticleRepository(app.db)),
    (userId) => auth.isAdmin(userId),
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

  /**
   * The two writes are `requireAuth` + `requireCsrfHeader`, and the order is the
   * one stage A fixed: auth first, so a caller with no credentials gets 401 and the
   * header is only consulted for someone already signed in.
   *
   * Deliberately NOT `requireAdmin`, which is where these endpoints differ from the
   * article writes: commenting is a reader action, so a plain signed-in user must
   * get 201 here — an admin-only assertion copied from the article suite would
   * assert the wrong permission model. `requireCsrfHeader` is on DELETE as much as
   * on POST (design §5's named trap: a state-changing request is state-changing
   * whichever verb carries it).
   *
   * The 201 body is the complete `CommentNode`, author included, so the client
   * appends the server's answer to its thread instead of reconstructing one from
   * its own token — the joined row and the echoed identity could otherwise drift.
   */
  app.post(
    '/api/v1/articles/:slug/comments',
    {
      onRequest: [requireAuth, requireCsrfHeader],
      schema: {
        params: SlugParamsSchema,
        body: CreateCommentSchema,
        response: { 201: CommentNodeSchema },
      },
    },
    async (request, reply) =>
      // `request.auth` is populated by `requireAuth` above; the non-null assertion
      // is safe exactly because that hook is attached here and nowhere else.
      reply.code(201).send(await service.create(request.params.slug, request.body, request.auth!.sub)),
  )

  app.delete(
    '/api/v1/comments/:id',
    {
      onRequest: [requireAuth, requireCsrfHeader],
      schema: {
        params: CommentIdParamsSchema,
      },
    },
    async (request, reply) => {
      await service.remove(request.params.id, request.auth!.sub)
      return reply.code(204).send()
    },
  )
}
