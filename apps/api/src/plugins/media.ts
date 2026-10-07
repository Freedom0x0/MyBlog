import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import type { Config } from '../config/index.js'
import {
  checkMediaBucket,
  createMediaS3Client,
  createS3MediaStore,
  ensureMediaBucket,
} from '../modules/uploads/s3-store.js'
import type { MediaStore } from '../modules/uploads/store.js'

declare module 'fastify' {
  interface FastifyInstance {
    /** The media storage port, wired to MinIO. See modules/uploads/store.ts. */
    media: MediaStore
    /**
     * Resolves if the media bucket answers; throws if it does not.
     *
     * A separate decorator rather than a fifth `MediaStore` method: the port is four
     * object-scoped methods so the upload rules can never reach a bucket-level
     * operation, and adding `ping()` to it would put that door back open for the one
     * consumer that has no business writing to storage.
     */
    mediaReady: () => Promise<void>
  }
}

/**
 * MinIO client and bucket assurance, decorated onto the instance as `app.media`.
 *
 * The shape of this plugin is copied from `plugins/redis.ts` for one reason: the
 * bucket may be unreachable, and that must not be a boot failure. So nothing here
 * awaits a network call that can reject — `ensureMediaBucket` catches everything and
 * logs. An API that refuses to start because the media bucket is down would take the
 * public blog with it, and article reads never touch MinIO; the wrong half of that
 * trade is obvious in hindsight and is exactly what Docker Desktop dying twice in one
 * week on this machine would have caused.
 *
 * `S3Client` itself connects lazily, so even creating it is offline work: the first
 * request that needs storage is the first thing that learns whether MinIO is up.
 */
export const mediaPlugin = fp(
  async (app: FastifyInstance, options: { config: Config }): Promise<void> => {
    const { config } = options

    const client = createMediaS3Client({
      endpoint: config.MEDIA_ENDPOINT,
      region: config.MEDIA_REGION,
      bucket: config.MEDIA_BUCKET,
      accessKeyId: config.MEDIA_ACCESS_KEY_ID,
      secretAccessKey: config.MEDIA_SECRET_ACCESS_KEY,
    })

    app.decorate(
      'media',
      createS3MediaStore({ client, bucket: config.MEDIA_BUCKET, log: app.log }),
    )

    app.decorate('mediaReady', () =>
      checkMediaBucket({ client, bucket: config.MEDIA_BUCKET }),
    )

    // Never rejects — see the docblock on `ensureMediaBucket` for what it logs when
    // it cannot do its job, and why the two ways a bucket can be "open" (policy for
    // read, CORS for browser writes) are not the same setting.
    await ensureMediaBucket({ client, bucket: config.MEDIA_BUCKET, log: app.log })

    /**
     * Close the connection pool on shutdown.
     *
     * Without this, `app.close()` can leave keep-alive sockets registered and the
     * process lingers after tests finish — the same class of hang the Redis plugin
     * had to solve, and the reason that file documents its shutdown ordering.
     */
    app.addHook('onClose', async () => {
      try {
        client.destroy()
      } catch (error) {
        // An unreachable server refusing goodbye is not a shutdown failure.
        app.log.warn({ err: error }, 'media client shutdown skipped')
      }
    })
  },
)
