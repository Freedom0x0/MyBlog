import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { FastifyInstance } from 'fastify'
import { ERROR_CODES, type CompletedUpload, type PresignedUpload } from 'shared'
import { buildApp } from '../app.js'
import { loadConfig } from '../config/index.js'
import { generateJti } from '../lib/tokens.js'
import {
  asciiBytes,
  cleanJpeg,
  cleanPng,
  containsSequence,
  gifWithXmpApplication,
  gpsCoordinateBytes,
  indexOfBytes,
  jpegApp1Exif,
  jpegScanTail,
  jpegStartOfFrame,
  jpegApp1Xmp,
  jpegWith,
  jpegWithGpsExif,
  pngWithWrongChunkOrder,
  pngWithChunkAfterIend,
  pngPaddedTo,
  pngWithGpsExif,
  webpWithGpsExif,
  EXIF_IDENTIFIER_BYTES,
} from './imageFixtures.js'
import { waitForRedis } from './wait-for-redis.js'

/**
 * Metadata stripping against the real MinIO (S8-c).
 *
 * `uploads.test.ts` proves the upload gates against a live bucket and
 * `lib/imageMetadata.test.ts` proves the byte surgery on bytes. This file is the join
 * that neither of them can make: it PUTs a file with a GPS IFD in it, lets the API strip
 * and rewrite it, and then asks **the bucket** — anonymously, the way a visitor's `<img>`
 * does — what is actually there.
 *
 * That distinction is the whole reason this file exists. The 32-byte head read stage F
 * already did was server-side, and a server-side assertion would still pass if the
 * rewrite silently no-oped, if MinIO served a cached copy, or if the object written back
 * were a different one. The only fact that protects anyone from a photo's coordinates is
 * the byte sequence that comes back over the public URL.
 *
 * Needs Postgres, Redis and MinIO, and fails loudly with instructions when a
 * precondition is missing — the convention in this suite (`articles-write.test.ts`),
 * never a skip. Separate from `uploads.test.ts` for one practical reason: the write rate
 * limiter counts per identity (60/min by default) and this file adds a dozen uploads, so
 * it runs as its own admin user rather than spending the other suite's budget.
 */

const TEST_MAX_UPLOAD_BYTES = 64 * 1024

const config = { ...loadConfig(), MEDIA_MAX_UPLOAD_BYTES: TEST_MAX_UPLOAD_BYTES }

let app: FastifyInstance
let probe: S3Client
let admin = ''
const run = randomUUID().slice(0, 8)
const issuedKeys: string[] = []

const GPS = gpsCoordinateBytes()

function adminHeaders(): Record<string, string> {
  return { authorization: `Bearer ${app.signAccessToken({ sub: admin, jti: generateJti() })}`, 'x-requested-with': 'portal' }
}

async function sign(contentType: string, size: number) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/uploads',
    headers: adminHeaders(),
    payload: { contentType, size },
  })
}

async function complete(key: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/uploads/complete',
    headers: adminHeaders(),
    payload: { key },
  })
}

/** The browser's half: a real PUT of real bytes at the signed URL, straight to MinIO. */
async function putToSignedUrl(uploadUrl: string, body: Uint8Array, declaredType: string): Promise<Response> {
  return fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': declaredType }, body })
}

/**
 * Upload one fixture end to end and return both the API's verdict and **the bytes an
 * anonymous visitor gets**. The pair, because a test that asserts on the response alone
 * is a test of the response.
 */
async function uploadAndFetch(contentType: string, bytes: Uint8Array): Promise<{ body: CompletedUpload; served: Uint8Array; status: number }> {
  const signed = (await sign(contentType, bytes.length)).json() as PresignedUpload
  issuedKeys.push(signed.key)
  expect(signed.key).toMatch(/\.png$|\.jpe?g$|\.gif$|\.webp$/)

  const put = await putToSignedUrl(signed.uploadUrl, bytes, contentType)
  expect(put.status, `PUT failed: ${await put.text()}`).toBe(200)

  const done = await complete(signed.key)
  expect(done.statusCode, `complete failed: ${done.body}`).toBe(200)
  const body = done.json() as CompletedUpload

  const fetched = await fetch(body.publicUrl)
  expect(fetched.status).toBe(200)

  return { body, served: new Uint8Array(await fetched.arrayBuffer()), status: fetched.status }
}

/** What the bucket says about an object's size, with credentials, without going through our API. */
async function storedSize(key: string): Promise<number> {
  const head = await probe.send(new HeadObjectCommand({ Bucket: config.MEDIA_BUCKET, Key: key }))
  return head.ContentLength ?? -1
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await probe.send(new HeadObjectCommand({ Bucket: config.MEDIA_BUCKET, Key: key }))
    return true
  } catch {
    return false
  }
}

async function listKeys(): Promise<string[]> {
  const listed = await probe.send(new ListObjectsV2Command({ Bucket: config.MEDIA_BUCKET }))
  return (listed.Contents ?? []).map((object) => object.Key ?? '')
}

beforeAll(async () => {
  const missing = [
    ['DATABASE_URL', 'a running Postgres (infra/docker-compose.yml: postgres)'],
    ['REDIS_URL', 'a running Redis (infra/docker-compose.yml: redis)'],
    ['MEDIA_ENDPOINT', 'a running MinIO (infra/docker-compose.yml: minio)'],
    ['MEDIA_BUCKET', 'the media bucket name'],
    ['MEDIA_ACCESS_KEY_ID', 'the media access key, from infra/.env MINIO_ROOT_USER'],
    ['MEDIA_SECRET_ACCESS_KEY', 'the media secret, from infra/.env MINIO_ROOT_PASSWORD'],
    ['MEDIA_PUBLIC_BASE_URL', 'the public base URL for media'],
  ]
    .filter(([name]) => process.env[name] === undefined)
    .map(([name, why]) => `${name} (${why})`)

  if (missing.length > 0) {
    throw new Error(
      `metadata-strip tests need ${missing.join(', ')} — copy apps/api/.env.example to apps/api/.env ` +
        `(values from infra/.env) and start the stack with ` +
        `"corepack pnpm@12.4.1 --dir infra exec docker compose up -d"`,
    )
  }

  app = await buildApp({ config })
  await waitForRedis(app)

  probe = new S3Client({
    endpoint: config.MEDIA_ENDPOINT,
    region: config.MEDIA_REGION,
    credentials: {
      accessKeyId: config.MEDIA_ACCESS_KEY_ID,
      secretAccessKey: config.MEDIA_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
    maxAttempts: 1,
  })

  try {
    await probe.send(new HeadBucketCommand({ Bucket: config.MEDIA_BUCKET }))
  } catch (error) {
    throw new Error(
      `media bucket "${config.MEDIA_BUCKET}" is not reachable at ${config.MEDIA_ENDPOINT}: ` +
        `${(error as Error).name}. Start MinIO with "docker compose -f infra/docker-compose.yml up -d minio".`,
      { cause: error },
    )
  }

  const inserted = await app.db.query<{ id: string }>(
    `insert into users (github_login, display_name, is_admin) values ($1, 'Strip Admin', true) returning id`,
    [`strip-admin-${run}`],
  )
  admin = inserted.rows[0]?.id ?? ''

  // Sweep wreckage from an earlier crashed run before this one starts counting residue.
  for (const key of await listKeys()) {
    await probe.send(new DeleteObjectCommand({ Bucket: config.MEDIA_BUCKET, Key: key }))
  }
})

afterAll(async () => {
  if (probe) {
    for (const key of await listKeys()) {
      await probe.send(new DeleteObjectCommand({ Bucket: config.MEDIA_BUCKET, Key: key }))
    }

    const residue = await listKeys()
    if (residue.length > 0) {
      throw new Error(
        `metadata-strip suite left ${residue.length} object(s) in ${config.MEDIA_BUCKET}: ` +
          `${residue.join(', ')} (this run issued ${issuedKeys.length} key(s))`,
      )
    }
  }

  if (app?.db) {
    await app.db.query(`delete from users where github_login like 'strip-%'`)
  }

  await app?.close()
  probe?.destroy()
})

describe('the strip switch and the contract it reports', () => {
  it('defaults to on with no environment variable set, because a privacy control that boots off is not a control', () => {
    // The key is defaulted rather than required on purpose (a required key is a CI
    // contract), so this is the assertion that it still cannot be accidentally absent.
    expect(loadConfig({ ...process.env, MEDIA_STRIP_METADATA: undefined }).MEDIA_STRIP_METADATA).toBe(true)
    expect(loadConfig({ ...process.env, MEDIA_STRIP_METADATA: 'false' }).MEDIA_STRIP_METADATA).toBe(false)
  })
})

describe('a photo with coordinates, published', () => {
  const exifJpeg = jpegWithGpsExif()

  it('serves a GPS-bearing JPEG with no trace of the GPS, and the same picture bytes', async () => {
    expect(containsSequence(exifJpeg, GPS)).toBe(true) // the fixture is what we say it is

    const { body, served } = await uploadAndFetch('image/jpeg', exifJpeg)

    // (b) the coordinates are gone from what a visitor fetches — the assertion this
    // stage is judged on. Not "the response got smaller": the bytes.
    expect(containsSequence(served, GPS)).toBe(false)
    expect(containsSequence(served, EXIF_IDENTIFIER_BYTES)).toBe(false)

    // (c) the entropy-coded segment — the photograph — is byte-identical to the one that
    // went up, and (d) SOF0 (the dimensions) did not move either.
    const scanAt = indexOfBytes(served, Uint8Array.from([0xff, 0xda]))
    expect(scanAt).toBeGreaterThan(0)
    expect(served.subarray(scanAt)).toEqual(jpegScanTail(exifJpeg))
    expect(jpegStartOfFrame(served)).toEqual(jpegStartOfFrame(exifJpeg))

    // (a) what came back parses as the type we published, and the API's own numbers agree
    // with the bucket rather than with the client.
    expect(body.contentType).toBe('image/jpeg')
    expect(body.sizeBytes).toBe(served.length)
    expect(body.strippedBytes).toBe(exifJpeg.length - served.length)
    expect(body.strippedBytes).toBe(jpegApp1Exif().length)
    await expect(storedSize(body.publicUrl.slice(config.MEDIA_PUBLIC_BASE_URL.length + 1))).resolves.toBe(served.length)
  })

  it('serves a JPEG whose coordinates are in XMP, not EXIF, with the same result', async () => {
    // Added because mutation M2 (keeping every `APP1` that is not identified as `Exif`)
    // went red only in the unit file: the bucket-level path had no XMP fixture, so the
    // "all APP1 goes, whatever its identifier" policy had one layer of teeth instead of
    // two. This is that second layer — same anonymous GET, same byte assertion.
    const segment = jpegApp1Xmp()
    const file = jpegWith(segment)
    const { body, served } = await uploadAndFetch('image/jpeg', file)

    expect(containsSequence(served, asciiBytes('GPSLatitude'))).toBe(false)
    expect(containsSequence(served, asciiBytes('http://ns.adobe.com/xap'))).toBe(false)
    expect(containsSequence(served, Uint8Array.from([0xff, 0xda]))).toBe(true)
    expect(served.subarray(indexOfBytes(served, Uint8Array.from([0xff, 0xda])))).toEqual(jpegScanTail(file))
    expect(body.strippedBytes).toBe(segment.length)
  })

  it('serves a GPS-bearing PNG with the eXIf chunk gone and every other chunk untouched', async () => {
    const file = pngWithGpsExif()
    const { body, served } = await uploadAndFetch('image/png', file)

    expect(containsSequence(served, GPS)).toBe(false)
    // The chunks we promised to keep are present *whole*, CRC and length field included.
    for (const type of ['IHDR', 'IDAT', 'IEND']) {
      expect(containsSequence(served, pngChunkOf(type))).toBe(true)
    }
    expect(body.strippedBytes).toBe(file.length - served.length)
    expect(body.sizeBytes).toBe(served.length)
  })

  it('serves a GPS-bearing WebP with its EXIF chunk gone and the RIFF size corrected', async () => {
    const file = webpWithGpsExif()
    const { body, served } = await uploadAndFetch('image/webp', file)

    expect(containsSequence(served, GPS)).toBe(false)
    const declared = (served[4] ?? 0) | ((served[5] ?? 0) << 8) | ((served[6] ?? 0) << 16) | ((served[7] ?? 0) << 24)
    expect(declared).toBe(served.length - 8)
    expect(body.contentType).toBe('image/webp')
    expect(body.strippedBytes).toBeGreaterThan(0)
  })

  it('is idempotent: completing the same key again strips nothing more and rewrites nothing', async () => {
    const signed = (await sign('image/jpeg', exifJpeg.length)).json() as PresignedUpload
    issuedKeys.push(signed.key)
    expect((await putToSignedUrl(signed.uploadUrl, exifJpeg, 'image/jpeg')).status).toBe(200)

    const first = await complete(signed.key)
    const second = await complete(signed.key)

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    const firstBody = first.json() as CompletedUpload
    const secondBody = second.json() as CompletedUpload

    // The second call reads the *already stripped* object, so its numbers are the object's,
    // and `strippedBytes` is 0 because there was nothing left to take. A stripper that
    // shrank the file on every call would fail this and would also be eating images.
    expect(secondBody.sizeBytes).toBe(firstBody.sizeBytes)
    expect(secondBody.strippedBytes).toBe(0)
    expect(secondBody.publicUrl).toBe(firstBody.publicUrl)
  })

  it('publishes a clean JPEG byte for byte, which is the proof the stripper is not a mangler', async () => {
    const file = cleanJpeg()
    const { body, served } = await uploadAndFetch('image/jpeg', file)

    expect(served).toEqual(file)
    expect(body.sizeBytes).toBe(file.length)
    expect(body.strippedBytes).toBe(0)
  })

  it('publishes a clean PNG byte for byte too, including its ancillary chunks', async () => {
    const { served } = await uploadAndFetch('image/png', cleanPng())
    expect(served).toEqual(cleanPng())
  })

  it('publishes an object exactly at the size cap, with the padding chunk it carries left intact', async () => {
    // The cap boundary used to be a 64 KiB run of zeros with a PNG signature in front —
    // not a file. Now it is a real PNG padded by one legitimate `tEXt` chunk, which also
    // proves the strip step does not refuse an object merely for being at the limit.
    const file = pngPaddedTo(TEST_MAX_UPLOAD_BYTES)
    expect(file.length).toBe(TEST_MAX_UPLOAD_BYTES)

    const signed = (await sign('image/png', file.length)).json() as PresignedUpload
    issuedKeys.push(signed.key)
    expect((await putToSignedUrl(signed.uploadUrl, file, 'image/png')).status).toBe(200)

    const done = await complete(signed.key)
    expect(done.statusCode, done.body).toBe(200)
    const body = done.json() as CompletedUpload
    expect(body.sizeBytes).toBe(TEST_MAX_UPLOAD_BYTES)
    expect(body.strippedBytes).toBe(0)

    const served = new Uint8Array(await (await fetch(body.publicUrl)).arrayBuffer())
    expect(served).toEqual(file)
  })
})

describe('files that are refused rather than published', () => {
  async function expectRefusedAndGone(contentType: string, bytes: Uint8Array, status: number, code: string): Promise<void> {
    const signed = (await sign(contentType, bytes.length)).json() as PresignedUpload
    issuedKeys.push(signed.key)
    expect((await putToSignedUrl(signed.uploadUrl, bytes, contentType)).status).toBe(200)

    const done = await complete(signed.key)
    expect(done.statusCode, done.body).toBe(status)
    expect((done.json() as { error: { code: string } }).error.code).toBe(code)

    // Refused means *deleted*, both to the bucket and to the anonymous reader.
    await expect(objectExists(signed.key)).resolves.toBe(false)
    const gone = await fetch(`${config.MEDIA_PUBLIC_BASE_URL.replace(/\/+$/, '')}/${signed.key}`)
    expect(gone.status).toBe(404)
  }

  it('refuses a valid PNG whose chunks are in a forbidden order, and leaves nothing public', async () => {
    // The negative control the brief asks for: real signature, real CRCs, real IDAT, and
    // a `gAMA` before `IHDR`. Stage F published this file. S8-c cannot prove where its
    // metadata ends, so it deletes it.
    await expectRefusedAndGone('image/png', pngWithWrongChunkOrder(), 415, ERROR_CODES.unsupportedMediaType)
  })

  it('refuses a PNG with metadata welded on after IEND, where a container walk cannot reach', async () => {
    await expectRefusedAndGone('image/png', pngWithChunkAfterIend(), 415, ERROR_CODES.unsupportedMediaType)
  })

  it('refuses a GIF that carries an XMP application block, because nothing here rewrites GIF blocks', async () => {
    await expectRefusedAndGone('image/gif', gifWithXmpApplication(), 415, ERROR_CODES.unsupportedMediaType)
  })

  it('names the refusal as a metadata problem, without quoting our own infrastructure', async () => {
    const signed = (await sign('image/png', pngWithChunkAfterIend().length)).json() as PresignedUpload
    issuedKeys.push(signed.key)
    await putToSignedUrl(signed.uploadUrl, pngWithChunkAfterIend(), 'image/png')

    const response = await complete(signed.key)
    const body = response.body

    expect(body).toContain('location data')
    expect(body).not.toContain(config.MEDIA_BUCKET)
    expect(body).not.toContain(config.MEDIA_SECRET_ACCESS_KEY)
    expect(body).not.toMatch(/[a-zA-Z]:[\\/]/)
    await expect(objectExists(signed.key)).resolves.toBe(false)
  })
})

/** The whole chunk of the *fixture* named `type`, for the byte-identity assertions above. */
function pngChunkOf(type: string): Uint8Array {
  const file = pngWithGpsExif()
  let cursor = 8
  while (cursor + 12 <= file.length) {
    const size = ((file[cursor] ?? 0) << 24) | ((file[cursor + 1] ?? 0) << 16) | ((file[cursor + 2] ?? 0) << 8) | (file[cursor + 3] ?? 0)
    const name = new TextDecoder().decode(file.subarray(cursor + 4, cursor + 8))
    if (name === type) return file.subarray(cursor, cursor + 12 + size)
    cursor += 12 + size
  }
  throw new Error(`fixture has no ${type} chunk`)
}

/** Read an object with credentials, for the assertions the API's own port cannot make. */
async function storedBytes(key: string): Promise<Uint8Array> {
  const response = await probe.send(new GetObjectCommand({ Bucket: config.MEDIA_BUCKET, Key: key }))
  const bytes = await response.Body?.transformToByteArray()
  if (bytes === undefined) throw new Error('GetObject returned no body for a key this suite created')
  return Uint8Array.from(bytes)
}

describe('what the bucket holds, not what the API said', () => {
  it('has the stripped bytes stored, not merely reported — an independent read with credentials', async () => {
    const { body } = await uploadAndFetch('image/jpeg', jpegWithGpsExif())
    const key = body.publicUrl.slice(config.MEDIA_PUBLIC_BASE_URL.length + 1)

    const stored = await storedBytes(key)
    expect(stored).toEqual(new Uint8Array(await (await fetch(body.publicUrl)).arrayBuffer()))
    expect(containsSequence(stored, GPS)).toBe(false)
    // The anonymous public read and the credentialed one agree, so the response and the
    // bucket are describing the same object.
    expect(stored.length).toBe(body.sizeBytes)
  })
})
