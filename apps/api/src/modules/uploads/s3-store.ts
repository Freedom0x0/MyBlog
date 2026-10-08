import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { ERROR_CODES } from 'shared'
import { ApiError } from '../../errors.js'
import type { MediaStore, ObjectInspection, PresignedPut } from './store.js'

/**
 * `MediaStore` on top of the AWS SDK, pointed at MinIO.
 *
 * Two things in this file are load-bearing beyond "makes the S3 call", and both are
 * about not talking too much:
 *
 * 1. **Every SDK error is caught and replaced.** The handler in
 *    `plugins/errorHandler.ts` forwards `error.message` verbatim for any status
 *    below 500, and AWS SDK errors carry the bucket name in their message and the
 *    S3 XML `<Code>` in their `name` (`NoSuchBucket`, `AccessDenied`). So no SDK
 *    error may reach the route layer unwrapped: `translate()` is the only thing that
 *    turns a storage failure into a response, and the message it writes never
 *    contains a name from the error it was handed.
 *
 * 2. **`forcePathStyle: true` is not optional.** MinIO here is addressed as
 *    `http://localhost:9000/<bucket>/<key>`, not `<bucket>.localhost:9000`; the
 *    default virtual-host addressing would ask for a DNS name that does not exist
 *    and the failure would look like a network problem. It also matters for what
 *    `presignPut` returns: the issued URL has the bucket in its path, which is the
 *    shape a browser can actually PUT to on this machine.
 */

/** The slice of config this adapter needs, named so `routes.ts` stays assembly-only. */
export interface MediaStorageConfig {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

/**
 * What this file needs from a logger, stated narrowly instead of importing Fastify's
 * `FastifyBaseLogger`.
 *
 * `app.log` satisfies it structurally, so production wiring is unchanged — but the
 * error-translation table below is the most safety-critical thing in the module (it
 * is what stands between an S3 XML `<Code>` and a public API response), and with a
 * Fastify type in the signature it could only be exercised by starting an app and a
 * bucket. Four methods is what makes `translate()` testable with a recording stub and
 * no network at all.
 */
export interface StorageLog {
  debug(object: unknown, message?: string): void
  info(object: unknown, message?: string): void
  warn(object: unknown, message?: string): void
  error(object: unknown, message?: string): void
}

/**
 * Names the SDK gives a "that key is not in the bucket" failure.
 *
 * `NotFound` is what S3-compatible servers answer to `HEAD` on a missing object
 * (there is no body to carry a code), `NoSuchKey` is the `GET` equivalent. Both mean
 * the same thing to the rules layer and both are the caller's problem, not ours.
 */
const MISSING_OBJECT_NAMES = new Set(['NotFound', 'NoSuchKey'])

/** Our own credentials or configuration being wrong — a 5xx, and never explained. */
const STORAGE_FAILURE_NAMES = new Set([
  'AccessDenied',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'NoSuchBucket',
  'AllAccessDisabled',
])

interface SdkErrorShape {
  name?: string
  code?: string
  message?: string
  $metadata?: { httpStatusCode?: number }
}

/**
 * The one error boundary for storage calls.
 *
 * The real error goes to the log, where it is useful to whoever operates this box;
 * the client gets one of three sentences we wrote. Note that `message` from the SDK
 * is *never* interpolated into any of them — it is the field that quotes the bucket
 * name and the XML code.
 */
function translate(error: unknown, operation: string, log: StorageLog): ApiError {
  const shape = (error ?? {}) as SdkErrorShape
  const name = shape.name ?? shape.code ?? 'Unknown'

  log.error(
    { err: error, operation, storageCode: name, httpStatus: shape.$metadata?.httpStatusCode },
    'media storage call failed',
  )

  if (MISSING_OBJECT_NAMES.has(name)) {
    return new ApiError(
      ERROR_CODES.notFound,
      'No uploaded object exists at that key',
      404,
    )
  }

  if (STORAGE_FAILURE_NAMES.has(name)) {
    // 5xx: the handler replaces the message with 'Internal server error' anyway, so
    // this sentence exists for the log line and for any future caller that reads it
    // server-side. The actionable detail — which credential, which bucket — is
    // deliberately not in it.
    return new ApiError(
      ERROR_CODES.internalError,
      'Media storage is not accepting requests from this API',
      503,
    )
  }

  return new ApiError(ERROR_CODES.internalError, 'Media storage operation failed', 500)
}

/**
 * Creates the client. Exported separately from the store because the startup bucket
 * assurance needs `HeadBucket`/`CreateBucket`/`PutBucketPolicy`, which are *not*
 * part of `MediaStore` — keeping them off the port is what stops the rules layer
 * from being able to create or re-policy a bucket at all.
 */
export function createMediaS3Client(config: MediaStorageConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
    /**
     * Flexible checksums, off. Measured on this machine with the installed SDK
     * (`@aws-sdk/client-s3@3.1146.0`) rather than reasoned about: with the default
     * `WHEN_SUPPORTED`, the presigned PUT URL comes back carrying
     * `x-amz-checksum-crc32=AAAAAA==` and `x-amz-sdk-checksum-algorithm=CRC32` in its
     * query — a CRC32 of an *empty* body, because nothing was supplied at signing time.
     * The browser PUTting real bytes cannot produce that value, so the failure lands on
     * the MinIO side of a cross-origin request where nobody can read it, while every
     * server-side assertion still passes. `WHEN_REQUIRED` gives back the URL SPIKE-E
     * measured by hand: `X-Amz-SignedHeaders=host`, nothing else.
     *
     * `responseChecksumValidation` is set for the mirror-image reason: a ranged GET is
     * not the whole object, so a checksum computed over the full object cannot match the
     * bytes this call reads.
     *
     * The absence of those parameters is asserted in `uploads-rules.test.ts`, so this
     * option cannot be "tidied away" by someone who has not seen the measurement.
     */
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    // One attempt, and bounded timeouts: an unreachable MinIO must fail fast rather than
    // sit in the SDK's default retry schedule. This is the difference between "uploads are
    // degraded" and "the admin editor is frozen for two minutes per click". Docker Desktop
    // on this machine has died twice this week, so the unreachable case is not hypothetical.
    // Note it also means a *transient* blip is a clean 5xx the client can retry, which is
    // the right answer for a call whose only job is to sign or measure one object.
    maxAttempts: 1,
    requestHandler: { requestTimeout: 5_000, connectTimeout: 2_000 },
  })
}

export function createS3MediaStore({
  client,
  bucket,
  log,
}: {
  client: S3Client
  bucket: string
  log: StorageLog
}): MediaStore {
  return {
    async presignPut(key, contentType, ttlSeconds): Promise<PresignedPut> {
      try {
        const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType })
        const uploadUrl = await getSignedUrl(client, command, { expiresIn: ttlSeconds })
        return { uploadUrl, expiresAt: expiresAtFromSignedUrl(uploadUrl, ttlSeconds) }
      } catch (error) {
        throw translate(error, 'presign', log)
      }
    },

    async inspect(key, headBytes): Promise<ObjectInspection> {
      let sizeBytes: number

      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
        // `ContentLength` is the server's measurement of what actually landed —
        // the only size number in stage F that is evidence of anything.
        sizeBytes = head.ContentLength ?? -1
        if (sizeBytes < 0) {
          throw new ApiError(ERROR_CODES.internalError, 'Media storage returned no size', 500)
        }
      } catch (error) {
        if (error instanceof ApiError) throw error
        throw translate(error, 'head', log)
      }

      try {
        if (sizeBytes === 0) {
          // A ranged GET of a 0-byte object is refused with `InvalidRange`, so the
          // empty head is reported directly rather than manufactured from a call
          // that cannot succeed.
          return { sizeBytes, head: new Uint8Array(0) }
        }

        const range = `bytes=0-${Math.min(headBytes, sizeBytes) - 1}`
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key, Range: range }),
        )

        const chunks: Buffer[] = []
        let collected = 0

        const body = response.Body
        if (body != null && typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
          for await (const chunk of body as AsyncIterable<Uint8Array>) {
            const part = Buffer.from(chunk)
            // Slice to the requested count: the server already honoured the range,
            // and this makes the cap a property of this function rather than of the
            // transport's arithmetic.
            const room = headBytes - collected
            chunks.push(part.length > room ? part.subarray(0, room) : part)
            collected += Math.min(part.length, room)
            if (collected >= headBytes) break
          }
        }

        return { sizeBytes, head: Buffer.concat(chunks, collected) }
      } catch (error) {
        if (error instanceof ApiError) throw error
        throw translate(error, 'get', log)
      }
    },

    /**
     * The server rewriting its own object — see `MediaStore.replace` for why this is the
     * one write on the port and what has to be true before it is called.
     *
     * `Body` is the bytes the caller read from this same key a moment ago, and
     * `ContentType` is the type measured from them. No checksum option is set here and
     * none is needed: `createMediaS3Client` already pins request checksum calculation to
     * `WHEN_REQUIRED`, so this PUT goes out with a plain `Content-Length` — which is the
     * right shape for a server-side call and the same one SPIKE-E measured for the
     * browser's PUT.
     */
    async replace(key, bytes, contentType): Promise<void> {
      try {
        await client.send(
          new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }),
        )
      } catch (error) {
        // Translated like every other SDK call, and it *rejects*: the caller has to know
        // whether the metadata-bearing object is still sitting in a public bucket.
        throw translate(error, 'put', log)
      }
    },

    /**
     * Best-effort by contract (see `store.ts`): a failure here is logged and
     * swallowed so the caller's 413/415 is never replaced by a 5xx about us.
     */
    async remove(key): Promise<void> {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
      } catch (error) {
        // Logged raw rather than routed through `translate`, which logs too: two lines
        // for one failed delete reads like two failures, and the important half is that
        // the caller still gets their 413/415.
        log.error(
          { err: error, key },
          'could not delete a rejected media object — it is still in the bucket, refuse to publish its URL',
        )
      }
    },
  }
}

/**
 * Reads the signature's own deadline out of the URL instead of computing
 * `Date.now() + ttl`.
 *
 * The distinction is who is right when they disagree: `X-Amz-Date` is what MinIO
 * will compare against its clock, so a client told "60 seconds from my API's clock"
 * could be told something MinIO does not enforce. Falling back to the local clock
 * keeps the field present if an endpoint ever omits the query parameter.
 */
export function expiresAtFromSignedUrl(uploadUrl: string, fallbackTtlSeconds: number): string {
  try {
    const url = new URL(uploadUrl)
    const amzDate = url.searchParams.get('X-Amz-Date')
    const expires = Number(url.searchParams.get('X-Amz-Expires'))

    const matched = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate ?? '')
    if (matched !== null && Number.isFinite(expires)) {
      const [, year, month, day, hour, minute, second] = matched
      const signedAt = Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
      )
      return new Date(signedAt + expires * 1000).toISOString()
    }
  } catch {
    // Unparseable URL: fall through to the local-clock answer.
  }

  return new Date(Date.now() + fallbackTtlSeconds * 1000).toISOString()
}

/**
 * Anonymous read, scoped to objects of this bucket — and *only* `s3:GetObject`.
 *
 * That choice is the SPIKE-E finding about `mc anonymous set download`: that preset
 * is `GetObject` **plus** `GetBucketLocation`/`ListBucket`, so anyone could read the
 * whole key list and see a cover image that has not been attached to any article
 * yet. A draft cover is not secret, but it is also not published, and a policy we
 * author costs nothing to make narrower.
 *
 * Note the asymmetry this leaves: anonymous listing is denied, so the integration
 * suite's residue check lists objects *with* credentials.
 */
export function publicReadPolicy(bucket: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'PublicReadGetObject',
        Effect: 'Allow',
        Principal: { AWS: ['*'] },
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  })
}

/**
 * One `HeadBucket`, no recovery: this exists for `/ready`, which needs to answer
 * "is the media store reachable?" and nothing else.
 *
 * It is deliberately NOT a method on `MediaStore`. The port is four object-scoped
 * methods by design (`store.ts`) so the upload rules can never reach a bucket-level
 * operation; a readiness probe is a different consumer and gets its own function, which
 * keeps "the rules layer cannot create or re-policy a bucket" true.
 */
export async function checkMediaBucket({
  client,
  bucket,
}: {
  client: S3Client
  bucket: string
}): Promise<void> {
  await client.send(new HeadBucketCommand({ Bucket: bucket }))
}

/**
 * Startup bucket assurance (design §4.3): one `HeadBucket`, and create-with-policy
 * only when the bucket is genuinely absent.
 *
 * **Never fatal.** An unreachable or unauthorised MinIO logs one loud line and the
 * API boots anyway, because the alternative trades the whole site for one feature:
 * article reads do not touch this bucket, and Docker Desktop dying on a dev laptop
 * must not take the public blog down with it. Uploads answer 5xx until it is fixed,
 * which is the correct blast radius.
 *
 * Why create-here-rather-than-in-compose-or-`mc`: the spike that proved presigned
 * uploads worked had to create `portal-media` by hand with `mc`, so the next machine
 * (or a CI runner) inherits an empty bucket and every F test fails on infrastructure
 * that nobody can see. Doing it in code means a fresh box and CI need no manual
 * step. In production the bucket is pre-provisioned by infrastructure, `HeadBucket`
 * hits, and this branch never runs — the price of that arrangement is that the app's
 * credentials must be allowed to create buckets and set policies, which design §4.3
 * accepts explicitly.
 *
 * **Bucket policy and CORS are two different settings and neither controls the
 * other.** The policy below governs public *read* (who may GET an object
 * anonymously). Who may *write* is governed by two things again: the signature (only
 * the API can produce one) and `MINIO_API_CORS_ALLOW_ORIGIN` on the MinIO server,
 * which decides which browser origins may even attempt a PUT against it. Setting the
 * policy does not open the door to other sites' uploads, and it does not close it
 * either — that one lives in `infra/docker-compose.yml`.
 */
export async function ensureMediaBucket({
  client,
  bucket,
  log,
}: {
  client: S3Client
  bucket: string
  log: StorageLog
}): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }))
    log.debug({ bucket }, 'media bucket present, no provisioning needed')
    return
  } catch (error) {
    const shape = (error ?? {}) as SdkErrorShape
    const status = shape.$metadata?.httpStatusCode
    const isAbsent = shape.name === 'NotFound' || status === 404

    if (!isAbsent) {
      // Unreachable, refused, or DNS — none of which creating can fix, and none of
      // which may stop boot.
      //
      // Wording constraint: this assurance runs ONCE, at plugin registration
      // (`plugins/media.ts`), not per request. Saying otherwise would send an
      // operator to wait for a self-heal that never happens — because if the bucket
      // is genuinely missing while MinIO is down, this call is the only thing that
      // would have created it, and it will not run again until the process restarts.
      log.error(
        { err: error },
        `media bucket check failed. Public article reads are unaffected; media uploads will fail until ` +
          `MinIO is reachable at the configured MEDIA_ENDPOINT. Start it with ` +
          `"docker compose -f infra/docker-compose.yml up -d minio" and confirm with ` +
          `"curl http://localhost:9000/minio/health/live". This check runs once at startup, so if the bucket ` +
          `was missing while MinIO was down, restart the API after MinIO is back — otherwise uploads keep ` +
          `answering 5xx against a bucket nobody created.`,
      )
      return
    }

    log.warn({ bucket }, 'media bucket missing, creating it with an object-read-only public policy')
  }

  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }))
    await client.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: publicReadPolicy(bucket) }))
    log.info(
      { bucket },
      'created media bucket and set public read for objects (anonymous listing stays denied)',
    )
  } catch (error) {
    log.error(
      { err: error, bucket },
      `could not create the media bucket. Uploads stay unavailable until it exists; create it out of band ` +
        `(docker compose up -d minio, then mc mb local/${bucket} && mc anonymous set-json policy.json local/${bucket}) ` +
        `— article reads are unaffected either way.`,
    )
  }
}
