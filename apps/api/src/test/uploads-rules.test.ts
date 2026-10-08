import { describe, expect, it } from 'vitest'
import { ERROR_CODES } from 'shared'
import { ApiError } from '../errors.js'
import {
  CompleteUploadSchema,
  MIME_BY_KEY_EXTENSION,
  RequestUploadSchema,
  UPLOAD_HEAD_SNIFF_BYTES,
  UPLOAD_KEY_PATTERN,
  UPLOAD_MAX_KEY_LENGTH,
  ALLOWED_UPLOAD_TYPES,
} from '../modules/uploads/schema.js'
import {
  buildUploadKey,
  sniffImageType,
  UploadService,
  type UploadLimits,
} from '../modules/uploads/service.js'
import type { MediaStore, ObjectInspection, PresignedPut } from '../modules/uploads/store.js'
import {
  createMediaS3Client,
  createS3MediaStore,
  ensureMediaBucket,
  expiresAtFromSignedUrl,
  publicReadPolicy,
  type StorageLog,
} from '../modules/uploads/s3-store.js'
import {
  cleanGif,
  cleanJpeg,
  cleanPng,
  cleanWebp,
  containsSequence,
  gpsCoordinateBytes,
  indexOfBytes,
  jpegScanTail,
  jpegWithGpsExif,
  jpegWithoutScan,
  pngWithBadCrc,
  pngWithChunkAfterIend,
} from './imageFixtures.js'

/**
 * Upload rules with no bucket behind them (stage F, first of two files).
 *
 * `uploads.test.ts` drives the real MinIO and answers "does the signature work, do
 * the bytes land, is the rejected object really gone". This file answers the
 * questions a real bucket answers badly: every rejection *branch* (which type buys
 * which extension, which key shape is refused before any storage call, which magic
 * byte wins), and the two properties that cannot be observed through a happy path at
 * all — that a foreign error never climbs out of the SDK, and that an unreachable
 * bucket cannot stop the API from booting. Those last two are tested against
 * `http://127.0.0.1:1`, a port nothing listens on, because that is the only way to
 * make a storage failure happen on demand in a test that must run without Docker.
 *
 * **The fixtures changed in S8-c, and that is the finding, not the tidy-up.** They used
 * to be 12- and 24-byte magic-byte stubs, which was enough while the only question
 * asked of the bytes was "which signature do they start with". `complete` now reads the
 * object whole and walks its structure, so a stub is *refused* — and refusing them here
 * is the proof that the new gate reaches the paths the old suite never exercised. They
 * are now real files with real image data (`imageFixtures.ts`), which also means the
 * strip assertions below can say "the picture bytes are identical" instead of "the byte
 * count went down".
 */

// ── fixtures: whole files, not signatures ────────────────────────────────────

const pngBytes = cleanPng()
const jpegBytes = cleanJpeg()
const gif89Bytes = cleanGif()
const webpBytes = cleanWebp()

/** Same four, as the *first bytes* a 32-byte sniff sees — the rejection branches still need those. */
const gif87Bytes = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x01, 0x00])

/** Same first four bytes as WebP, different file: catches a sniff that only checks `RIFF`. */
const aviBytes = new TextEncoder().encode('RIFF\x38\x00\x00\x00AVI LIST')

const svgBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><circle r="9"/></svg>')

const keyFor = (extension: string): string =>
  `uploads/2026/10/${'0f1e2d3c4b5a69788796a5b4c3d2e1f0'}.${extension}`

const limits: UploadLimits = {
  maxBytes: 1024,
  presignTtlSeconds: 60,
  publicBaseUrl: 'http://media.test/portal-media',
  stripMetadata: true,
}

// ── the stand-in that makes the rules observable ─────────────────────────────

interface FakeObject {
  sizeBytes: number
  /** The object's bytes. `inspect` slices them to whatever count the caller asked for. */
  head: Uint8Array
}

class FakeStore implements MediaStore {
  readonly presigned: { key: string; contentType: string; ttlSeconds: number }[] = []
  readonly inspected: { key: string; headBytes: number }[] = []
  readonly removed: string[] = []
  readonly replaced: { key: string; bytes: Uint8Array; contentType: string }[] = []

  /**
   * What `inspect` returns on the *second* call, which is the strip's full-object read.
   * A rule about "the object changed under verification" is only testable by a store
   * that can say something different the second time, and no real bucket is willing to
   * be that inconsistent on schedule.
   */
  secondInspection: ObjectInspection | null = null

  /** When set, `replace` rejects with this instead of recording the write. */
  replaceFailure: Error | null = null

  constructor(private readonly object: FakeObject | null = null) {}

  async presignPut(key: string, contentType: string, ttlSeconds: number): Promise<PresignedPut> {
    this.presigned.push({ key, contentType, ttlSeconds })
    return {
      uploadUrl: `http://media.test/portal-media/${key}?X-Amz-Signature=stub`,
      expiresAt: '2026-10-05T12:01:00.000Z',
    }
  }

  async inspect(key: string, headBytes: number): Promise<ObjectInspection> {
    this.inspected.push({ key, headBytes })

    if (this.secondInspection !== null && this.inspected.length > 1) {
      const second = this.secondInspection
      this.secondInspection = null
      return second
    }

    if (this.object === null) {
      throw new ApiError(ERROR_CODES.notFound, 'No uploaded object exists at that key', 404)
    }
    return {
      sizeBytes: this.object.sizeBytes,
      head: this.object.head.subarray(0, headBytes),
    }
  }

  async replace(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    if (this.replaceFailure !== null) throw this.replaceFailure
    this.replaced.push({ key, bytes, contentType })
  }

  async remove(key: string): Promise<void> {
    this.removed.push(key)
  }
}

/** Runs `work` and returns the ApiError it threw, failing the test if it threw anything else. */
async function expectApiError(work: Promise<unknown>): Promise<ApiError> {
  try {
    await work
  } catch (error) {
    expect(error, `threw something that is not an ApiError: ${String(error)}`).toBeInstanceOf(ApiError)
    return error as ApiError
  }
  throw new Error('expected an ApiError, none was thrown')
}

describe('sniffImageType — the only evidence stage F trusts', () => {
  it('recognises each allowed format from its own signature', () => {
    expect(sniffImageType(pngBytes)).toBe('image/png')
    expect(sniffImageType(jpegBytes)).toBe('image/jpeg')
    expect(sniffImageType(gif87Bytes)).toBe('image/gif')
    expect(sniffImageType(gif89Bytes)).toBe('image/gif')
    expect(sniffImageType(webpBytes)).toBe('image/webp')
  })

  it('refuses an SVG even though it is a perfectly good image', () => {
    // The flagship case: XML that can carry script, served from our own media origin.
    expect(sniffImageType(svgBytes)).toBeNull()
  })

  it('requires the second WebP probe, not just RIFF', () => {
    // A sniff that stopped at offset 4 would call this AVI a WebP and serve it as one.
    expect(sniffImageType(aviBytes)).toBeNull()
    // Same bytes truncated below offset 11: the `WEBP` at 8-11 is unreadable, so the
    // answer must be "nothing I allow", not a guess.
    expect(sniffImageType(webpBytes.subarray(0, 8))).toBeNull()
  })

  it('refuses truncated and empty heads rather than matching on partial bytes', () => {
    expect(sniffImageType(new Uint8Array(0))).toBeNull()
    expect(sniffImageType(Uint8Array.from([0xff, 0xd8]))).toBeNull() // JPEG missing the third byte
    expect(sniffImageType(pngBytes.subarray(0, 7))).toBeNull() // PNG missing the 0x0a tail
    expect(sniffImageType(Uint8Array.from([0x00, 0x01, 0x02, 0x03]))).toBeNull()
  })

  it('reads the type from the bytes when the declaration was a lie', () => {
    // Declaration said image/png; the bytes are a GIF. The bytes win, always —
    // SPIKE-E hard fact 2 says the declared type is unsigned and stored verbatim.
    expect(sniffImageType(gif89Bytes)).toBe('image/gif')
  })

  it('is decided within the head size the service asks the store for', () => {
    // The 12-byte WebP floor is the reason the read is 32 and not 8: an assertion here
    // that only looks at the first 8 bytes would let a RIFF/WAVE file through as a WebP.
    expect(UPLOAD_HEAD_SNIFF_BYTES).toBeGreaterThanOrEqual(12)
    expect(sniffImageType(webpBytes.subarray(0, UPLOAD_HEAD_SNIFF_BYTES))).toBe('image/webp')
  })
})

describe('buildUploadKey — nothing a caller supplied is in here', () => {
  it('matches the pattern the completion endpoint will accept', () => {
    // The pairing this whole design depends on: a key we issue must pass our own shape
    // check. Break the pattern or the key format and this fails — which is the point.
    for (const extension of Object.values(ALLOWED_UPLOAD_TYPES)) {
      expect(UPLOAD_KEY_PATTERN.test(buildUploadKey(new Date(), extension))).toBe(true)
    }
  })

  it('uses the UTC year and a zero-padded month', () => {
    expect(buildUploadKey(new Date(Date.UTC(2026, 0, 15)), 'png')).toMatch(/^uploads\/2026\/01\//)
    expect(buildUploadKey(new Date(Date.UTC(2026, 11, 31)), 'webp')).toMatch(/^uploads\/2026\/12\/.*\.webp$/)
  })

  it('issues a different token every time', () => {
    const keys = new Set(Array.from({ length: 200 }, () => buildUploadKey(new Date(), 'png')))
    expect(keys.size).toBe(200)
    for (const key of keys) {
      expect(key.slice('uploads/2026/10/'.length, -'.png'.length)).toMatch(/^[0-9a-f]{32}$/)
    }
  })

  it('maps each allowed type to exactly one extension, and back to itself', () => {
    // Both directions are checked because the mismatch test compares a *measured* MIME
    // against the extension in the key: if the table and the reverse table disagreed, a
    // valid PNG could be refused, or a mismatch could be waved through.
    expect(ALLOWED_UPLOAD_TYPES).toEqual({
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
    })
    for (const [mime, extension] of Object.entries(ALLOWED_UPLOAD_TYPES)) {
      expect(MIME_BY_KEY_EXTENSION[extension]).toBe(mime)
    }
    expect(Object.values(ALLOWED_UPLOAD_TYPES)).not.toContain('svg')
    expect(Object.keys(ALLOWED_UPLOAD_TYPES)).not.toContain('image/svg+xml')
  })
})

describe('request DTOs', () => {
  it('discards a filename if a client sends one', () => {
    // There is no `filename` field, and Zod strips unknown keys, so this is the
    // strongest form of "we never use the caller's name": the value does not survive
    // validation, so it cannot reach a key, a log line, or a storage call.
    const parsed = RequestUploadSchema.parse({
      contentType: 'image/png',
      size: 10,
      filename: '../../etc/passwd',
      name: 'cover.png',
      path: '/tmp/cover.png',
    })
    expect(Object.keys(parsed).sort()).toEqual(['contentType', 'size'])
    expect(JSON.stringify(parsed)).not.toContain('passwd')
  })

  it('bounds the declared size to something a number can be', () => {
    expect(RequestUploadSchema.safeParse({ contentType: 'image/png', size: 0 }).success).toBe(false)
    expect(RequestUploadSchema.safeParse({ contentType: 'image/png', size: -1 }).success).toBe(false)
    expect(RequestUploadSchema.safeParse({ contentType: 'image/png', size: 1.5 }).success).toBe(false)
    expect(RequestUploadSchema.safeParse({ contentType: 'image/png', size: '1024' }).success).toBe(false)
  })

  it('bounds the key string so a huge one is refused by the DTO, not the bucket', () => {
    expect(CompleteUploadSchema.safeParse({ key: 'x'.repeat(UPLOAD_MAX_KEY_LENGTH + 1) }).success).toBe(false)
    expect(CompleteUploadSchema.safeParse({ key: '' }).success).toBe(false)
  })
})

describe('POST /api/v1/uploads rules (sign)', () => {
  it('refuses every type outside the whitelist with 415', async () => {
    for (const contentType of [
      'image/svg+xml',
      'text/html',
      'application/x-executable',
      'image/png+xml',
      'IMAGE/PNG', // exact-match allowlist: no case folding, no prefix matching
      'image/pn',
      '',
    ]) {
      const store = new FakeStore()
      const error = await expectApiError(new UploadService(store, limits).sign({ contentType, size: 10 }))
      expect(error.code).toBe(ERROR_CODES.unsupportedMediaType)
      expect(error.statusCode).toBe(415)
      expect(store.presigned).toHaveLength(0) // refused means *not signed*
    }
  })

  it('names the accepted types in the 415 so the caller can fix the call', async () => {
    const error = await expectApiError(
      new UploadService(new FakeStore(), limits).sign({ contentType: 'image/svg+xml', size: 10 }),
    )
    expect(error.message).toContain('image/png')
    expect(error.message).toContain('image/webp')
  })

  it('signs each whitelisted type and picks its extension from the table', async () => {
    const cases: [string, string][] = [
      ['image/png', '.png'],
      ['image/jpeg', '.jpg'],
      ['image/gif', '.gif'],
      ['image/webp', '.webp'],
    ]

    for (const [contentType, extension] of cases) {
      const store = new FakeStore()
      const result = await new UploadService(store, limits).sign({ contentType, size: 11 })

      expect(result.key.endsWith(extension)).toBe(true)
      expect(store.presigned).toEqual([{ key: result.key, contentType, ttlSeconds: 60 }])
    }
  })

  it('early-exits on a declared size over the cap with 413', async () => {
    const store = new FakeStore()
    const error = await expectApiError(
      new UploadService(store, limits).sign({ contentType: 'image/png', size: limits.maxBytes + 1 }),
    )
    expect(error.code).toBe(ERROR_CODES.payloadTooLarge)
    expect(error.statusCode).toBe(413)
    expect(store.presigned).toHaveLength(0)

    // The boundary itself signs: the cap means "up to", not "strictly under".
    await expect(new UploadService(store, limits).sign({ contentType: 'image/png', size: limits.maxBytes })).resolves
      .toBeTruthy()
  })

  it('does not hand back a public URL, because nothing has been uploaded yet', async () => {
    const result = await new UploadService(new FakeStore(), limits).sign({ contentType: 'image/png', size: 11 })
    expect(Object.keys(result).sort()).toEqual(['expiresAt', 'key', 'uploadUrl'])
    expect(JSON.stringify(result)).not.toContain('publicUrl')
  })
})

describe('POST /api/v1/uploads/complete rules (verify)', () => {
  it('refuses a foreign or malformed key with 400 before touching storage', async () => {
    const rejected = [
      'uploads/2026/10/0f1e2d3c4b5a69788796a5b4c3d2e1f0.svg', // svg extension, even with a valid token
      'uploads/2026/10/0f1e2d3c4b5a69788796a5b4c3d2e1f0.exe',
      'uploads/2026/10/0f1e2d3c4b5a69788796a5b4c3d2e1f0', // no extension
      'uploads/2026/1/../0f1e2d3c4b5a69788796a5b4c3d2e1f0.png', // traversal
      '../../uploads/2026/10/0f1e2d3c4b5a69788796a5b4c3d2e1f0.png',
      'objects/2026/10/0f1e2d3c4b5a69788796a5b4c3d2e1f0.png', // not our prefix
      'uploads/2026/1/0f1e2d3c4b5a69788796a5b4c3d2e1f0.png', // unpadded month
      'uploads/26/10/0f1e2d3c4b5a69788796a5b4c3d2e1f0.png', // two-digit year
      'uploads/2026/10/0F1E2D3C4B5A69788796A5B4C3D2E1F0.png', // uppercase hex
      'uploads/2026/10/0f1e2d3c4b5a69788796a5b4c3d2e1f.png', // 31 hex chars
      'uploads/2026/10/0f1e2d3c4b5a69788796a5b4c3d2e1f0.png\n', // trailing control char
      'uploads/2026/10/0f1e2d3c4b5a69788796a5b4c3d2e1f0 .png',
      'portal-media/uploads/2026/10/0f1e2d3c4b5a69788796a5b4c3d2e1f0.png', // bucket name in the key
    ]

    for (const key of rejected) {
      const store = new FakeStore({ sizeBytes: 8, head: pngBytes })
      const error = await expectApiError(new UploadService(store, limits).complete({ key }))
      expect(error.code, `key ${key} should be 400`).toBe(ERROR_CODES.badRequest)
      expect(error.statusCode).toBe(400)
      // No storage call means the endpoint cannot be used to probe arbitrary paths,
      // which is the reason the shape check runs before `inspect` rather than after.
      expect(store.inspected, `key ${key} must not reach the bucket`).toHaveLength(0)
      // 400 messages are forwarded verbatim to the client, so the message must stay
      // our own sentence: no echo of the caller's probe, no bucket name, no server path.
      expect(error.message, `message echoed ${key}`).not.toContain(key)
      expect(error.message).not.toContain('portal-media')
      expect(error.message).not.toContain('\\')
      expect(error.message).not.toMatch(/[a-zA-Z]:[\\/]/) // a Windows path would name our filesystem
    }
  })

  it('reports a well-shaped but absent object as 404 without deleting anything', async () => {
    const store = new FakeStore(null) // inspect throws the not-found ApiError
    const error = await expectApiError(
      new UploadService(store, limits).complete({ key: keyFor('png') }),
    )
    expect(error.statusCode).toBe(404)
    expect(store.removed).toEqual([])
  })

  it('reads the head for the gates, then the whole object for the strip', async () => {
    const store = new FakeStore({ sizeBytes: pngBytes.length, head: pngBytes })
    await new UploadService(store, limits).complete({ key: keyFor('png') })

    // Two calls, and the second one's count is the upload cap rather than 32 because the
    // size gate in between has already proved the object cannot be bigger than that.
    expect(store.inspected).toEqual([
      { key: keyFor('png'), headBytes: UPLOAD_HEAD_SNIFF_BYTES },
      { key: keyFor('png'), headBytes: limits.maxBytes },
    ])
  })

  it('accepts a real PNG and returns the URL that was earned', async () => {
    const store = new FakeStore({ sizeBytes: 70, head: pngBytes })
    const result = await new UploadService(store, limits).complete({ key: keyFor('png') })
    expect(result).toEqual({
      publicUrl: `http://media.test/portal-media/${keyFor('png')}`,
      contentType: 'image/png',
      sizeBytes: 70,
      strippedBytes: 0,
    })
    expect(store.removed).toEqual([]) // accepted means it stays
    expect(store.replaced).toEqual([]) // and a file with nothing to take is not rewritten
  })

  it('never lets a config value double up the slash in the URL', async () => {
    const store = new FakeStore({ sizeBytes: 70, head: pngBytes })
    const service = new UploadService(store, { ...limits, publicBaseUrl: 'http://media.test/portal-media/' })
    const result = await service.complete({ key: keyFor('png') })
    expect(result.publicUrl).toBe(`http://media.test/portal-media/${keyFor('png')}`)
    expect(result.publicUrl).not.toContain('//portal-media')
  })

  it('accepts both jpeg spellings an issued key can carry', async () => {
    for (const extension of ['jpg', 'jpeg']) {
      const store = new FakeStore({ sizeBytes: 300, head: jpegBytes })
      const result = await new UploadService(store, limits).complete({ key: keyFor(extension) })
      expect(result.contentType).toBe('image/jpeg')
      expect(store.removed).toEqual([])
    }
  })

  it('rejects a GIF served under a png key, and deletes it', async () => {
    // Declared image/png → key .png → bytes are GIF. The extension and the content must
    // agree for the object to survive, or the bucket fills with files whose names lie.
    const store = new FakeStore({ sizeBytes: 900, head: gif89Bytes })
    const error = await expectApiError(new UploadService(store, limits).complete({ key: keyFor('png') }))
    expect(error.code).toBe(ERROR_CODES.unsupportedMediaType)
    expect(error.statusCode).toBe(415)
    expect(store.removed).toEqual([keyFor('png')])
  })

  it('rejects an SVG uploaded under a png key, and deletes it', async () => {
    const store = new FakeStore({ sizeBytes: svgBytes.length, head: svgBytes })
    const error = await expectApiError(new UploadService(store, limits).complete({ key: keyFor('png') }))
    expect(error.statusCode).toBe(415)
    expect(store.removed).toEqual([keyFor('png')])
    // The message must not name the bucket or quote a server path: 415 is forwarded verbatim.
    expect(error.message).not.toContain('portal-media')
  })

  it('rejects unrecognised bytes, and deletes them', async () => {
    const store = new FakeStore({ sizeBytes: 200, head: Uint8Array.from([0x00, 0x01, 0x02, 0x03]) })
    const error = await expectApiError(new UploadService(store, limits).complete({ key: keyFor('png') }))
    expect(error.statusCode).toBe(415)
    expect(store.removed).toEqual([keyFor('png')])
  })

  it('rejects a 0-byte object rather than sniffing nothing and passing', async () => {
    const store = new FakeStore({ sizeBytes: 0, head: new Uint8Array(0) })
    const error = await expectApiError(new UploadService(store, limits).complete({ key: keyFor('png') }))
    expect(error.statusCode).toBe(415)
    expect(store.removed).toEqual([keyFor('png')])
  })

  it('rejects an object over the cap on its measured size, and deletes it', async () => {
    // The declaration said 11 bytes; the object is 4 KiB. Only the measured size counts,
    // because the declared one is neither signed nor binding (SPIKE-E hard facts 1 and 2).
    const key = keyFor('png')
    const store = new FakeStore({ sizeBytes: limits.maxBytes * 4, head: pngBytes })
    const error = await expectApiError(new UploadService(store, limits).complete({ key }))
    expect(error.code).toBe(ERROR_CODES.payloadTooLarge)
    expect(error.statusCode).toBe(413)
    expect(store.removed).toEqual([key])
  })

  it('measures against the cap, not against the caller’s claim, at the boundary', async () => {
    const atCap = new FakeStore({ sizeBytes: limits.maxBytes, head: pngBytes })
    await expect(new UploadService(atCap, limits).complete({ key: keyFor('png') })).resolves
      .toMatchObject({ sizeBytes: limits.maxBytes })

    const overCap = new FakeStore({ sizeBytes: limits.maxBytes + 1, head: pngBytes })
    await expect(new UploadService(overCap, limits).complete({ key: keyFor('png') })).rejects.toBeInstanceOf(ApiError)
    expect(overCap.removed).toEqual([keyFor('png')])
  })

  it('reports the measured type and size, not the declared ones', async () => {
    // A GIF signed under a .gif key: contentType in the response comes from the bytes and
    // sizeBytes from HeadObject, so an article can store dimensions-free metadata that is
    // at least not the browser's assertion about itself.
    const store = new FakeStore({ sizeBytes: 900, head: gif89Bytes })
    const result = await new UploadService(store, limits).complete({ key: keyFor('gif') })
    expect(result).toEqual({
      publicUrl: `http://media.test/portal-media/${keyFor('gif')}`,
      contentType: 'image/gif',
      sizeBytes: 900,
      strippedBytes: 0,
    })
    // GIF is the format the stripper declines (see `lib/imageMetadata.ts`): nothing is
    // taken out, so nothing is written back, and the object a visitor gets is the object
    // the browser PUT.
    expect(store.replaced).toEqual([])
  })
})

describe('metadata stripping in complete (S8-c)', () => {
  const gps = gpsCoordinateBytes()
  const exifJpeg = jpegWithGpsExif()

  function recordingLog(): { entries: unknown[]; log: NonNullable<UploadLimits['log']> } {
    const entries: unknown[] = []
    const record = (object: unknown): void => {
      entries.push(object)
    }
    return { entries, log: { info: record, warn: record, error: record } }
  }

  it('takes the GPS out and overwrites the object before the URL is reported', async () => {
    const key = keyFor('jpg')
    const store = new FakeStore({ sizeBytes: exifJpeg.length, head: exifJpeg })
    const result = await new UploadService(store, limits).complete({ key })

    expect(store.replaced).toHaveLength(1)
    const [written] = store.replaced
    expect(written?.key).toBe(key)
    expect(written?.contentType).toBe('image/jpeg') // the measured type, not the declared one
    expect(containsSequence(written?.bytes ?? new Uint8Array(0), gps)).toBe(false)

    // What the caller is told reflects the object as it now stands, not as it arrived.
    expect(result.sizeBytes).toBe(exifJpeg.length - 195)
    expect(result.strippedBytes).toBe(195)
    expect(result.publicUrl).toBe(`http://media.test/portal-media/${key}`)
    expect(store.removed).toEqual([])
  })

  it('publishes a metadata-free image without writing to the bucket at all', async () => {
    const store = new FakeStore({ sizeBytes: pngBytes.length, head: pngBytes })
    const result = await new UploadService(store, limits).complete({ key: keyFor('png') })

    expect(store.replaced).toEqual([])
    expect(result.strippedBytes).toBe(0)
    expect(result.sizeBytes).toBe(pngBytes.length)
  })

  it('refuses a file whose structure it cannot walk, and deletes it rather than publishing it', async () => {
    // `jpegWithoutScan` is a real marker chain with real EXIF and no picture: the parser
    // cannot say where the metadata ends, and "we could not prove there are no
    // coordinates" is decided as a refusal. Same for the PNG with an eXIf chunk welded on
    // after IEND — the one place a stripper that stops at the container's end would miss.
    const cases: [string, Uint8Array][] = [
      [keyFor('jpg'), jpegWithoutScan()],
      [keyFor('png'), pngWithChunkAfterIend()],
      [keyFor('png'), pngWithBadCrc()],
    ]

    for (const [key, bytes] of cases) {
      const store = new FakeStore({ sizeBytes: bytes.length, head: bytes })
      const error = await expectApiError(new UploadService(store, limits).complete({ key }))

      expect(error.statusCode, key).toBe(415)
      expect(error.code, key).toBe(ERROR_CODES.unsupportedMediaType)
      expect(store.removed, `${key} must not survive the refusal`).toEqual([key])
      expect(store.replaced, key).toEqual([])
    }
  })

  it('says what could not be proven, in the client\'s own language and with no server detail', async () => {
    const store = new FakeStore({ sizeBytes: 600, head: jpegWithoutScan() })
    const error = await expectApiError(new UploadService(store, limits).complete({ key: keyFor('jpg') }))

    // 415 messages are forwarded verbatim by `errorHandler`, so this is the leak check.
    expect(error.message).toContain('could not be checked for location data')
    expect(error.message).not.toContain('portal-media')
    expect(error.message).not.toContain('\\')
    expect(error.message).not.toMatch(/[a-zA-Z]:[\\/]/)
  })

  it('refuses when the object changes between the two measurements, because the gates judged the other one', async () => {
    const key = keyFor('jpg')
    const store = new FakeStore({ sizeBytes: cleanJpeg().length, head: cleanJpeg() })
    // Same key, different bytes on the strip's read: the window is real (a signed PUT
    // stays usable until it expires) and this is the only place it is closed. Both files
    // are valid JPEGs, so nothing but the identity of the object can be the reason.
    store.secondInspection = { sizeBytes: exifJpeg.length, head: exifJpeg }

    const error = await expectApiError(new UploadService(store, limits).complete({ key }))
    expect(error.statusCode).toBe(409)
    expect(error.code).toBe(ERROR_CODES.conflict)
    expect(store.removed).toEqual([key])
    expect(store.replaced).toEqual([])
  })

  it('deletes the object and reports the storage failure when the rewrite itself fails', async () => {
    // Fail closed, out loud. If `replace` rejects, the metadata-bearing object is still in
    // a public bucket, so the only acceptable answers are "it is gone" and "we did not
    // publish it" — never a 200 with a URL.
    const key = keyFor('jpg')
    const store = new FakeStore({ sizeBytes: exifJpeg.length, head: exifJpeg })
    const storageError = new ApiError(ERROR_CODES.internalError, 'Media storage operation failed', 500)
    store.replaceFailure = storageError

    const { entries, log } = recordingLog()
    const error = await expectApiError(new UploadService(store, { ...limits, log }).complete({ key }))

    expect(error).toBe(storageError)
    expect(store.removed).toEqual([key])
    expect(entries).toHaveLength(0) // the adapter already logged it; the service does not log a 5xx twice
  })

  it('logs which containers left, so an operator can see the control working', async () => {
    const { entries, log } = recordingLog()
    const store = new FakeStore({ sizeBytes: exifJpeg.length, head: exifJpeg })
    await new UploadService(store, { ...limits, log }).complete({ key: keyFor('jpg') })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      key: keyFor('jpg'),
      format: 'JPEG',
      removedBytes: 195,
      containers: ['APP1/Exif'],
    })
  })

  it('does nothing at all when the kill switch is off, and says so on every upload', async () => {
    const { entries, log } = recordingLog()
    const store = new FakeStore({ sizeBytes: exifJpeg.length, head: exifJpeg })
    const result = await new UploadService(store, { ...limits, stripMetadata: false, log }).complete({
      key: keyFor('jpg'),
    })

    // One read, not two: the full-object fetch is part of the strip, so switching it off
    // also switches off the extra round trip.
    expect(store.inspected).toEqual([{ key: keyFor('jpg'), headBytes: UPLOAD_HEAD_SNIFF_BYTES }])
    expect(store.replaced).toEqual([])
    expect(result.strippedBytes).toBe(0)
    expect(result.sizeBytes).toBe(exifJpeg.length)
    expect(entries).toHaveLength(1)
  })

  it('keeps a GPS-bearing image out of the response even when nothing else about it is wrong', async () => {
    // The point of the stage, stated as one assertion: after a successful `complete`, the
    // bytes we would have written contain no coordinates. The end-to-end version of this
    // — fetched anonymously, from the bucket — is in `uploads-strip.test.ts`.
    const store = new FakeStore({ sizeBytes: exifJpeg.length, head: exifJpeg })
    await new UploadService(store, limits).complete({ key: keyFor('jpg') })

    const written = store.replaced[0]?.bytes
    expect(written).toBeDefined()
    expect(containsSequence(written ?? new Uint8Array(0), gps)).toBe(false)
    expect(containsSequence(exifJpeg, gps)).toBe(true)
    // and the picture part of it came through untouched
    expect(written?.subarray(indexOfBytes(written ?? new Uint8Array(0), Uint8Array.from([0xff, 0xda])))).toEqual(
      jpegScanTail(exifJpeg),
    )
  })
})

describe('expiry is read off the signature, not guessed from the local clock', () => {
  it('adds X-Amz-Expires to X-Amz-Date', () => {
    const url = 'http://media.test/portal-media/uploads/2026/10/x.png' +
      '?X-Amz-Date=20261005T120000Z&X-Amz-Expires=60'
    expect(expiresAtFromSignedUrl(url, 999)).toBe('2026-10-05T12:01:00.000Z')
  })

  it('crosses a month end correctly, which is where hand-rolled date maths breaks', () => {
    const url = 'http://media.test/portal-media/uploads/2026/10/x.png' +
      '?X-Amz-Date=20261031T235930Z&X-Amz-Expires=60'
    expect(expiresAtFromSignedUrl(url, 60)).toBe('2026-11-01T00:00:30.000Z')
  })

  it('falls back to now plus the ttl when the URL carries no date', () => {
    const before = Date.now()
    const value = expiresAtFromSignedUrl('http://media.test/portal-media/uploads/2026/10/x.png', 60)
    const parsed = Date.parse(value)
    expect(Number.isNaN(parsed)).toBe(false)
    expect(parsed - before).toBeGreaterThanOrEqual(59_000)
    expect(parsed - before).toBeLessThanOrEqual(61_000)
  })

  it('survives a malformed URL rather than throwing at the boundary', () => {
    expect(() => expiresAtFromSignedUrl('not a url', 30)).not.toThrow()
  })
})

describe('storage adapter: nothing foreign climbs out of it', () => {
  /**
   * A port nothing listens on. The SDK fails with its own error object — the same
   * class of error a wrong credential or a missing bucket produces — and what is under
   * test is that `createS3MediaStore` replaces it with an `ApiError` we wrote. This is
   * the only way to prove the leak rule in `plugins/errorHandler.ts` (statuses below 500
   * forward `error.message` verbatim) holds for storage calls in an environment with no
   * MinIO, and it is why these three tests exist even though `uploads.test.ts` covers the
   * same calls against a real bucket.
   */
  const deadConfig = {
    endpoint: 'http://127.0.0.1:1',
    region: 'us-east-1',
    bucket: 'portal-media',
    accessKeyId: 'stub-access-key-id',
    secretAccessKey: 'stub-secret-access-key',
  }

  function recordingLog(): { entries: unknown[]; log: StorageLog } {
    const entries: unknown[] = []
    const record = (object: unknown): void => {
      entries.push(object)
    }
    return {
      entries,
      log: {
        debug: record,
        info: record,
        warn: record,
        error: record,
      },
    }
  }

  const LEAK_MARKERS = [
    'portal-media', // the bucket name, which is in every SDK message
    'ECONNREFUSED',
    '127.0.0.1',
    'stub-access-key-id',
    'stub-secret-access-key',
    'X-Amz-Signature',
    'NoSuchBucket',
    'AccessDenied',
    '<Code>',
    'at ', // a stack frame
  ]

  it('turns a failed HeadObject into an ApiError that quotes nothing', async () => {
    const { log } = recordingLog()
    const store = createS3MediaStore({ client: createMediaS3Client(deadConfig), bucket: deadConfig.bucket, log })

    const error = await expectApiError(store.inspect(keyFor('png'), 32))
    expect(error.statusCode).toBeGreaterThanOrEqual(500)
    expect(error.code).toBe(ERROR_CODES.internalError)
    for (const marker of LEAK_MARKERS) {
      expect(error.message, `message leaked ${marker}`).not.toContain(marker)
    }
  })

  it('never rejects from remove, so a 415 stays a 415', async () => {
    // `remove` is best-effort by contract. If it could reject, a failed delete would
    // replace the caller's rejection with a 500 about our infrastructure — and the
    // object would still be sitting in a public bucket either way.
    const { entries, log } = recordingLog()
    const store = createS3MediaStore({ client: createMediaS3Client(deadConfig), bucket: deadConfig.bucket, log })

    await expect(store.remove(keyFor('png'))).resolves.toBeUndefined()
    expect(entries.length).toBeGreaterThan(0) // the failure is logged, not swallowed silently
  })

  it('boots against a dead bucket without throwing', async () => {
    // design §4.3's "must not be fatal": Docker Desktop dying must not take the public
    // site down with it, and this plugin runs at assembly, so a throw here is the whole
    // API refusing to start.
    const { entries, log } = recordingLog()
    const client = createMediaS3Client(deadConfig)

    await expect(ensureMediaBucket({ client, bucket: deadConfig.bucket, log })).resolves.toBeUndefined()
    expect(entries.length).toBeGreaterThan(0)
    client.destroy()
  })

  it('signs a real PUT URL offline, path-style, with only host signed', async () => {
    const { log } = recordingLog()
    const client = createMediaS3Client(deadConfig)
    const store = createS3MediaStore({ client, bucket: deadConfig.bucket, log })
    const key = keyFor('png')

    const { uploadUrl, expiresAt } = await store.presignPut(key, 'image/png', 60)
    const url = new URL(uploadUrl)

    // Path-style: MinIO on this box has no per-bucket DNS, so the bucket must be in the
    // path or the signature is addressed to a host that does not exist.
    expect(url.pathname).toBe(`/portal-media/${key}`)
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60')
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/us-east-1/s3/aws4_request')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    expect(url.searchParams.get('X-Amz-Content-Sha256')).toBe('UNSIGNED-PAYLOAD')

    /**
     * `X-Amz-SignedHeaders=host`, measured rather than assumed, and it is the reason the
     * magic-byte sniff exists at all: Content-Type is outside the signature, so the
     * declared type cannot be the check. If this ever changes, the sniff stays correct
     * either way — but a future reader should know which side of the trade we are on.
     */
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')

    /**
     * No checksum headers. With the SDK's default `WHEN_SUPPORTED` this URL carries
     * `x-amz-checksum-crc32=AAAAAA==` — the CRC32 of an *empty* body, computed at signing
     * time — which a browser PUT of real bytes cannot possibly reproduce. It was measured
     * on this machine, and `createMediaS3Client` opts out of it; this assertion is what
     * keeps someone from "tidying up" that option.
     */
    expect(uploadUrl).not.toContain('x-amz-checksum')
    expect(uploadUrl).not.toContain('x-amz-sdk-checksum-algorithm')

    expect(expiresAt).toBe(expiresAtFromSignedUrl(uploadUrl, 60))

    // The signature must not carry the secret it was made with.
    expect(uploadUrl).not.toContain(deadConfig.secretAccessKey)
    client.destroy()
  })
})

describe('public read policy', () => {
  it('grants object reads and nothing else', () => {
    const policy = JSON.parse(publicReadPolicy('portal-media')) as {
      Statement: { Action: string[]; Resource: string[]; Principal: { AWS: string[] } }[]
    }

    expect(policy.Statement).toHaveLength(1)
    const [statement] = policy.Statement
    expect(statement.Action).toEqual(['s3:GetObject'])
    expect(statement.Resource).toEqual(['arn:aws:s3:::portal-media/*'])
    expect(statement.Principal.AWS).toEqual(['*'])

    /**
     * Not `ListBucket`. SPIKE-E found that MinIO's `anonymous set download` preset also
     * grants `GetBucketLocation` and `ListBucket`, which means anyone could read the key
     * list — including a cover image uploaded but not yet attached to any article. Reads
     * of a known key are what a blog needs; enumeration is a bonus nobody asked for.
     */
    expect(JSON.stringify(policy)).not.toContain('ListBucket')
    expect(JSON.stringify(policy)).not.toContain('PutObject')
  })
})
