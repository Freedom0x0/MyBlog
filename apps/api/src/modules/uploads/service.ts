import { randomBytes } from 'node:crypto'
import {
  ERROR_CODES,
  type CompletedUpload,
  type CompleteUploadInput,
  type PresignedUpload,
  type RequestUploadInput,
} from 'shared'
import { ApiError } from '../../errors.js'
import {
  ALLOWED_UPLOAD_TYPES,
  MIME_BY_KEY_EXTENSION,
  UPLOAD_HEAD_SNIFF_BYTES,
  UPLOAD_KEY_PATTERN,
  type ImageExtension,
} from './schema.js'
import type { MediaStore } from './store.js'

/**
 * Upload rules: what we will sign for, and what an object has to prove before we
 * will call its URL public.
 *
 * No `request`, no `reply`, no SDK — the same discipline as the other services, and
 * here it buys something specific: every branch of the verification can be driven by
 * a `MediaStore` stand-in that returns whatever bytes and size we name, including
 * combinations a real bucket makes expensive to produce (a 6 MB object, an SVG that
 * claims to be a PNG, an object that vanished between two calls).
 */

export interface UploadLimits {
  /** Server-measured cap, enforced in `complete` — the only cap that binds. */
  maxBytes: number
  /** Lifetime of the signed PUT. */
  presignTtlSeconds: number
  /** Public origin + bucket path, used only to prefix a key we already shape-checked. */
  publicBaseUrl: string
}

/** PNG's 8-byte signature, which is also a self-check: bytes 4-7 are the CRLF/LF of the file format. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_MAGIC = [0xff, 0xd8, 0xff]
const GIF_MAGICS = [
  [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], // "GIF87a"
  [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], // "GIF89a"
]
const RIFF = [0x52, 0x49, 0x46, 0x46] // "RIFF" at 0-3
const WEBP = [0x57, 0x45, 0x42, 0x50] // "WEBP" at 8-11

function startsWith(head: Uint8Array, magic: number[], offset = 0): boolean {
  if (head.length < offset + magic.length) return false
  return magic.every((byte, index) => head[offset + index] === byte)
}

/**
 * The type the bytes say it is, or null when they say nothing we allow.
 *
 * This is the hard gate of stage F, and the reason it exists is SPIKE-E's hard fact
 * 2: a presigned PUT signs only `host`, so the `Content-Type` on the object is the
 * client's own declaration, stored verbatim and echoed back by `HeadObject`. That
 * makes the declared type, and the `ContentType` field of a HEAD response, evidence
 * about *nothing*. The first bytes are the only thing in the pipeline the client does
 * not get to choose freely, so the decision is made here.
 *
 * Order is by cheapest unambiguous signature first; WebP needs the second probe at
 * offset 8, which is why `UPLOAD_HEAD_SNIFF_BYTES` is not 8.
 */
export function sniffImageType(head: Uint8Array): string | null {
  if (startsWith(head, PNG_MAGIC)) return 'image/png'
  if (startsWith(head, JPEG_MAGIC)) return 'image/jpeg'
  if (GIF_MAGICS.some((magic) => startsWith(head, magic))) return 'image/gif'
  if (startsWith(head, RIFF) && startsWith(head, WEBP, 8)) return 'image/webp'
  return null
}

/** `uploads/2026/10/<32 hex>.png` — pure so the month padding is testable. */
export function buildUploadKey(now: Date, extension: ImageExtension): string {
  const year = now.getUTCFullYear().toString().padStart(4, '0')
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `uploads/${year}/${month}/${randomBytes(16).toString('hex')}.${extension}`
}

/**
 * The extension part of an issued key, lowercased and only ever one of five strings
 * — callers must have shape-checked the key first.
 */
function extensionOf(key: string): string {
  return key.slice(key.lastIndexOf('.') + 1).toLowerCase()
}

export class UploadService {
  constructor(
    private readonly store: MediaStore,
    private readonly limits: UploadLimits,
  ) {}

  /**
   * Step 1: sign a PUT.
   *
   * Returns a capability, never a public URL — the object does not exist yet and may
   * never exist, and a URL handed out now would be a promise this endpoint cannot
   * keep. The caller earns `publicUrl` at `complete`.
   */
  async sign(input: RequestUploadInput): Promise<PresignedUpload> {
    const extension = ALLOWED_UPLOAD_TYPES[input.contentType]

    if (extension === undefined) {
      // 415 rather than a 400 from an enum: design §6, and the message names what we
      // do accept because a caller that was refused has to be able to fix the call.
      throw new ApiError(
        ERROR_CODES.unsupportedMediaType,
        `Unsupported image type '${input.contentType}'. Allowed: ${Object.keys(ALLOWED_UPLOAD_TYPES).join(', ')}`,
        415,
      )
    }

    if (input.size > this.limits.maxBytes) {
      /**
       * An early exit, NOT a defence, and the distinction is the whole point of the
       * comment: because presigned PUT has no `content-length-range` (SPIKE-E hard
       * fact 1) and the declared size is not covered by the signature (hard fact 2),
       * this number cannot constrain what actually lands. Anyone determined enough
       * declares 1 KiB and PUTs 100 MB. The bound that holds is `HeadObject`'s
       * `ContentLength` in `complete`, which measures the object rather than asking
       * about it. What this check buys is only that we do not spend a signature and
       * someone's bandwidth on a rejection we can already see coming.
       */
      throw new ApiError(
        ERROR_CODES.payloadTooLarge,
        `Declared size ${input.size} exceeds the ${this.limits.maxBytes}-byte upload limit`,
        413,
      )
    }

    // The key comes from the clock and 16 random bytes and from nowhere else: no
    // filename is accepted by the DTO, so there is no filename to sanitise. Two
    // things that buys: nothing like `../../etc/passwd` can ever reach a storage call
    // (design §4.2), and two people uploading `cover.png` cannot overwrite each other.
    const key = buildUploadKey(new Date(), extension)

    const { uploadUrl, expiresAt } = await this.store.presignPut(
      key,
      input.contentType,
      this.limits.presignTtlSeconds,
    )

    return { key, uploadUrl, expiresAt }
  }

  /**
   * Step 2: verify what landed, then — and only then — name its public URL.
   */
  async complete(input: CompleteUploadInput): Promise<CompletedUpload> {
    if (!UPLOAD_KEY_PATTERN.test(input.key)) {
      // Says only that the shape is wrong. It must not echo the key back (this is a
      // 400, so `errorHandler` forwards the message verbatim) and must not say which
      // part failed in a way that reads like a bucket listing.
      throw new ApiError(
        ERROR_CODES.badRequest,
        'key must be one issued by POST /api/v1/uploads: uploads/<yyyy>/<mm>/<32 hex digits>.<png|jpg|jpeg|gif|webp>',
        400,
      )
    }

    /**
     * No ledger of "this key was signed by me", deliberately.
     *
     * A per-signature single-use record would mean state this module does not have
     * (there is no uploads table, and stage F was told not to add one — Redis is the
     * natural home and that is S6's groundwork). What closes the hole without it:
     * the key shape above is only reachable by a caller who *has* admin rights, this
     * endpoint can neither read nor write an object — `inspect` reports bytes back to
     * the admin who asked, and `remove` only ever deletes an object this endpoint is
     * about to refuse — and the bucket holds nothing but images destined to be public
     * on the same blog. Being able to ask "does this key exist, and what are its
     * first 32 bytes" is therefore information the caller already owns the right to,
     * and being able to *write* a URL is not something this endpoint does: writing
     * needs a signature, and signing needs the same admin call. Recorded as a gap in
     * the task notes rather than papered over here.
     */
    const inspected = await this.store.inspect(input.key, UPLOAD_HEAD_SNIFF_BYTES)

    if (inspected.sizeBytes > this.limits.maxBytes) {
      // Rejecting means deleting: a 413 that leaves the object in a publicly
      // readable bucket has refused the *response*, not the upload, and the bytes are
      // now served to anyone. The deletion is the point, so it is asserted by name in
      // the integration suite.
      await this.store.remove(input.key)
      throw new ApiError(
        ERROR_CODES.payloadTooLarge,
        `Uploaded object is ${inspected.sizeBytes} bytes, over the ${this.limits.maxBytes}-byte limit`,
        413,
      )
    }

    const sniffed = sniffImageType(inspected.head)

    if (sniffed === null) {
      await this.store.remove(input.key)
      throw new ApiError(
        ERROR_CODES.unsupportedMediaType,
        'Uploaded object is not a recognised PNG, JPEG, GIF or WebP image',
        415,
      )
    }

    const expected = MIME_BY_KEY_EXTENSION[extensionOf(input.key)]

    if (expected === undefined || expected !== sniffed) {
      // The key's extension was chosen by the *declared* type, so this branch is the
      // "declared image/gif, uploaded a PNG" case: real bytes of a different allowed
      // format. (An SVG does not get here — it sniffs to null and is refused by the
      // branch above, which is the stricter of the two gates.) Same rule as above: a
      // refused object must not stay public, because its filename would be a lie that
      // the next reader of the bucket has no way to suspect.
      await this.store.remove(input.key)
      throw new ApiError(
        ERROR_CODES.unsupportedMediaType,
        `Uploaded bytes are ${sniffed}, which does not match the '${extensionOf(input.key)}' key this was signed for`,
        415,
      )
    }

    return {
      // Assembled from config plus a key that just passed a strict shape check — the
      // only two ingredients this line is allowed to use. Nothing from the client's
      // body reaches it, and the declared `contentType` was not used either: the type
      // reported here is the one measured from the bytes.
      publicUrl: `${this.limits.publicBaseUrl.replace(/\/+$/, '')}/${input.key}`,
      contentType: sniffed,
      sizeBytes: inspected.sizeBytes,
    }
  }
}
