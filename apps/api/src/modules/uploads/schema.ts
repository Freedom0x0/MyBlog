import { z } from 'zod'
import type {
  AssertEquivalent,
  CompletedUpload,
  CompleteUploadInput,
  PresignedUpload,
  RequestUploadInput,
} from 'shared'

/**
 * Upload DTOs and the constants that encode the rules the DTOs deliberately do NOT
 * encode.
 *
 * The split matters: anything that must answer 415 or 413 lives in `service.ts`,
 * because a Zod rejection inside a route schema becomes Fastify's 400
 * `VALIDATION_ERROR`. Design §6 says a refused *media type* is 415 and an oversized
 * object is 413, so those two decisions cannot be schema checks. The schemas here
 * bound shape only (is this a string? is this a positive integer?) and hand the
 * semantic decisions to the service.
 */

/** The extensions this API will ever issue, keyed on the whitelisted MIME type. */
export type ImageExtension = 'png' | 'jpg' | 'gif' | 'webp'

/**
 * The allowed declared types, and the extension each one buys.
 *
 * **SVG is excluded on purpose, and the reason is not "it is not really a raster
 * image".** An SVG document *is* XML: it can carry `<script>`, an `onload=`
 * attribute, an `<image href="data:text/html,...">`, and a foreignObject that
 * renders arbitrary HTML. Once one is served from the media origin it is an
 * execution point on our own name — the same-origin relationship an `<img>` tag
 * normally gives us is exactly what makes it dangerous, and a Content-Type we do
 * not control (see the note on `MediaStore.presignPut`) means the browser will
 * believe whatever the file says it is. Cover art does not need it; PNG/JPEG/GIF/
 * WebP do.
 *
 * The four entries are a map rather than an array because the same table answers
 * two different questions — "is this type allowed?" and "what extension goes in the
 * key?" — and an array would make those two lookups drift apart.
 */
export const ALLOWED_UPLOAD_TYPES: Record<string, ImageExtension> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/**
 * Reverse lookup: extension → the MIME type its contents must sniff as.
 *
 * Both `jpg` and `jpeg` are listed because the key pattern below accepts either
 * (`jpe?g` is the S3/SVG-free family any browser produces, and refusing a key we
 * did not issue only ever turns a working image into a 400). The comparison this
 * feeds is *measured type against key extension*, which is the check that decides
 * whether an object survives.
 */
export const MIME_BY_KEY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/**
 * The only key shape this endpoint will complete.
 *
 * A strict shape check, not a prefix check, because a free-form `key` would turn
 * `POST /uploads/complete` into a probe for arbitrary object paths in our own
 * bucket: `HEAD` anything, learn whether it exists, and read its first 32 bytes.
 * Every character class here is one we issue — digits for the year and month,
 * lowercase hex for the token, one of four extensions — so a passing key is
 * necessarily one this API signed for.
 */
export const UPLOAD_KEY_PATTERN = /^uploads\/\d{4}\/\d{2}\/[0-9a-f]{32}\.(png|jpe?g|gif|webp)$/

/**
 * How many leading bytes the completion check reads back.
 *
 * 32, and the floor that decides the number is 12: WebP's magic is `RIFF` at 0-3
 * *and* `WEBP` at 8-11, so a shorter read cannot tell a WebP file from anything
 * else that starts with `RIFF` (a WAV or an AVI). 32 also covers every PNG chunk
 * header and enough of a JPEG's first marker segment to be company policy-baiting
 * cheap — the object is already in memory on the server's side of a ranged GET.
 */
export const UPLOAD_HEAD_SNIFF_BYTES = 32

/** Bound on the `key` string a caller may send, so a 10 MB key is a 400 not a hang. */
export const UPLOAD_MAX_KEY_LENGTH = 512

/** Bound on the declared type string for the same reason. */
export const UPLOAD_MAX_CONTENT_TYPE_LENGTH = 64

/**
 * `POST /api/v1/uploads` body.
 *
 * `contentType` is a plain string, not an enum, for the reason stated at the top of
 * this file: an enum failure is a 400 and design §6 wants 415 with our own message
 * naming what we accept.
 *
 * There is **no `filename` field and no plan to add one**. A name a browser gets
 * from a file picker is attacker-chosen text, and every way of using it has a
 * failure mode: path traversal (`../../etc/passwd`), collision between two people's
 * `cover.png`, and an extension that lies about its own contents. The key is built
 * from the clock and 16 random bytes instead (design §4.2).
 */
export const RequestUploadSchema = z.object({
  contentType: z.string().min(1).max(UPLOAD_MAX_CONTENT_TYPE_LENGTH),
  /**
   * Advisory only, and the comment is load-bearing so nobody upgrades it in their
   * head: this number is not signed and not binding (SPIKE-E hard fact 2), so the
   * real cap is `MEDIA_MAX_UPLOAD_BYTES` re-measured by `HeadObject` in `complete`.
   * Over here it is only an early exit — refuse to sign for something we would
   * reject anyway rather than spending a signature and 5 MB of someone's upload on
   * a foregone conclusion. `positive()` because a 0-byte upload can never sniff as
   * an image, so accepting the declaration would only guarantee a later 415.
   */
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})

/**
 * `POST /api/v1/uploads/complete` body. Shape-bounded only; the strict pattern
 * lives in the service so the 400 says what the problem is.
 */
export const CompleteUploadSchema = z.object({
  key: z.string().min(1).max(UPLOAD_MAX_KEY_LENGTH),
})

export const PresignedUploadSchema = z.object({
  key: z.string(),
  uploadUrl: z.string(),
  expiresAt: z.iso.datetime(),
})

export const CompletedUploadSchema = z.object({
  publicUrl: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
})

/**
 * Drift guards, exported so `noUnusedLocals` cannot mistake them for dead code.
 * Each one is the reason the contract can live in `shared` as an interface while
 * validation lives here as Zod: if the two disagree, `tsc` stops compiling.
 */
export const REQUEST_UPLOAD_MATCHES_CONTRACT: AssertEquivalent<
  z.infer<typeof RequestUploadSchema>,
  RequestUploadInput
> = true

export const COMPLETE_UPLOAD_MATCHES_CONTRACT: AssertEquivalent<
  z.infer<typeof CompleteUploadSchema>,
  CompleteUploadInput
> = true

export const PRESIGNED_UPLOAD_MATCHES_CONTRACT: AssertEquivalent<
  z.infer<typeof PresignedUploadSchema>,
  PresignedUpload
> = true

export const COMPLETED_UPLOAD_MATCHES_CONTRACT: AssertEquivalent<
  z.infer<typeof CompletedUploadSchema>,
  CompletedUpload
> = true
