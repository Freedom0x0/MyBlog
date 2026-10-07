import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { requireAdmin } from '../auth/guards.js'
import { requireCsrfHeader } from '../../plugins/auth.js'
import { requireWriteRateLimit } from '../../plugins/rateLimit.js'
import { CompletedUploadSchema, CompleteUploadSchema, PresignedUploadSchema, RequestUploadSchema } from './schema.js'
import { UploadService } from './service.js'

/**
 * HTTP boundary only: parse, authorise, call the service, serialize.
 *
 * No error body is built here and no rule is decided here — both endpoints throw,
 * and `plugins/errorHandler` formats. That is not decoration: this module is the one
 * place in the API where a foreign error (an AWS SDK exception naming our bucket)
 * could reach a client, and keeping the translating work in `s3-store.ts` is what
 * makes "nothing but `ApiError` leaves this boundary" checkable by reading two files
 * instead of five.
 */
export const uploadRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new UploadService(app.media, {
    maxBytes: app.config.MEDIA_MAX_UPLOAD_BYTES,
    presignTtlSeconds: app.config.MEDIA_PRESIGN_TTL_SECONDS,
    publicBaseUrl: app.config.MEDIA_PUBLIC_BASE_URL,
    stripMetadata: app.config.MEDIA_STRIP_METADATA,
    log: app.log,
  })

  /**
   * Said once at startup rather than discovered later, because everything this line is
   * warning about is silent per request: uploads keep answering 200, images keep
   * publishing, and the only difference is that a phone's coordinates go out with them.
   * `MEDIA_STRIP_METADATA` defaults to `true`, so this branch means someone set it.
   */
  if (!app.config.MEDIA_STRIP_METADATA) {
    app.log.warn(
      'MEDIA_STRIP_METADATA=false: uploaded images keep their EXIF/GPS and XMP, and the media bucket is public. ' +
        'This is the emergency escape hatch for a parser that refuses real photographs, not a setting to ship with.',
    )
  }

  /**
   * Sign a PUT. `requireAdmin` then `requireCsrfHeader`, in that order, exactly as
   * the article writes do: an unauthenticated call must get 401 and a non-admin 403
   * before anything else happens, because both of these endpoints are the front door
   * to writing into a publicly readable bucket.
   *
   * 201 because a new capability was created — one key, 60 seconds, not reusable.
   * 200 would understate it: there is nothing here to re-fetch, and a client that
   * wants a second window has to ask again and gets a different key.
   */
  app.post(
    '/api/v1/uploads',
    {
      onRequest: [requireAdmin, requireCsrfHeader, requireWriteRateLimit],
      schema: {
        body: RequestUploadSchema,
        response: { 201: PresignedUploadSchema },
      },
    },
    async (request, reply) => reply.code(201).send(await service.sign(request.body)),
  )

  /**
   * Verify what actually landed and, if it passed, return the URL worth storing.
   *
   * 200 rather than 201: this call creates no resource. It reports a verdict about an
   * object the client already PUT, and the object was created by MinIO, not by us.
   */
  app.post(
    '/api/v1/uploads/complete',
    {
      onRequest: [requireAdmin, requireCsrfHeader, requireWriteRateLimit],
      schema: {
        body: CompleteUploadSchema,
        response: { 200: CompletedUploadSchema },
      },
    },
    async (request) => service.complete(request.body),
  )
}
