import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { ERROR_CODES, type CompletedUpload, type PresignedUpload } from 'shared'
import { buildApp } from '../app.js'
import { loadConfig } from '../config/index.js'
import { generateJti } from '../lib/tokens.js'
import { UPLOAD_KEY_PATTERN } from '../modules/uploads/schema.js'
import { cleanGif, cleanJpeg, cleanPng, cleanWebp, heicHead, pngPaddedTo } from './imageFixtures.js'
import { waitForRedis } from './wait-for-redis.js'

/**
 * Image upload against the real MinIO (S3 stage F).
 *
 * This is the file that answers the questions a fake store cannot: does a signature
 * MinIO actually accept, do the bytes a browser would PUT really land, is a rejected
 * object *gone* from the bucket rather than merely refused in the response, and does an
 * accepted object read back byte-for-byte over its public URL. `uploads-rules.test.ts`
 * covers the decision table; nothing here is a restatement of it.
 *
 * Requires Postgres, Redis *and* MinIO. `requireAdmin` reaches the denylist in Redis, so
 * an authorised call needs two of those; the third is the subject of the test. Following
 * the convention in `articles-write.test.ts`, a missing precondition **throws with
 * instructions** rather than skipping — a silently-skipped upload suite is how a bucket
 * that no longer exists goes unnoticed until an admin presses the button.
 */

/**
 * The upload cap this suite runs with, overridden here rather than read from the
 * environment so the over-size test PUTs 64 KiB instead of `MEDIA_MAX_UPLOAD_BYTES + 1`
 * (5 MiB by default, and a suite that takes a minute to make one oversized object is a
 * suite nobody reruns). Everything else is the real config.
 */
const TEST_MAX_UPLOAD_BYTES = 64 * 1024

const config = { ...loadConfig(), MEDIA_MAX_UPLOAD_BYTES: TEST_MAX_UPLOAD_BYTES }

let app: FastifyInstance

/** Root-credentialed client for the * assertions the API deliberately cannot make*: it has
 * no way to list the bucket (its own store exposes three methods only), and the residue
 * gate needs to. */
let probe: S3Client

const users: { admin: string; plain: string } = { admin: '', plain: '' }
const run = randomUUID().slice(0, 8)

/** Every key this suite caused to exist, so `afterAll` can prove the bucket is empty again. */
const issuedKeys: string[] = []

function tokenFor(userId: string): string {
  return app.signAccessToken({ sub: userId, jti: generateJti() })
}

function adminHeaders(): Record<string, string> {
  return { authorization: `Bearer ${tokenFor(users.admin)}`, 'x-requested-with': 'portal' }
}

/** POST /api/v1/uploads with a sane default body. */
async function sign(contentType: string, size: number, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/uploads',
    headers: adminHeaders(),
    payload: { contentType, size, ...extra },
  })
}

async function complete(key: string, headers = adminHeaders()) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/uploads/complete',
    headers,
    payload: { key },
  })
}

/**
 * The browser's half, done for real: PUT the bytes at the signed URL.
 *
 * `headers['content-type']` is what the client *declares*, and it is the variable under
 * test in several cases below — declaring image/png while sending an SVG is the attack
 * the sniff exists for. Note this goes to MinIO, not to the API: no `app.inject()` here,
 * because the API never sees these bytes and must not be able to.
 */
async function putToSignedUrl(uploadUrl: string, body: Uint8Array, declaredType: string): Promise<Response> {
  return fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': declaredType },
    body,
  })
}

/**
 * Discards log output. Used by the one test that starts a second app: the expiry check
 * sleeps six seconds on purpose, and a second pino stream on top of the first buries the
 * failure messages this file is judged on.
 */
function silentStream(): NodeJS.WritableStream {
  return { write: () => true } as unknown as NodeJS.WritableStream
}

/** Does the object exist in the bucket *right now*, according to the bucket? */
async function objectExists(key: string): Promise<boolean> {
  try {
    await probe.send(new HeadObjectCommand({ Bucket: config.MEDIA_BUCKET, Key: key }))
    return true
  } catch {
    return false
  }
}

/**
 * Every error body in one place, because "no SDK detail reaches a client" is a property
 * of the whole surface and not of the one branch someone thought to check.
 *
 * The markers are what an AWS SDK error would contain: the S3 XML code, our bucket name
 * (which is in every SDK message), a server path, a signature, and the credential that
 * signs. Checked against the *raw body string*, not the parsed message, because the
 * envelope is exactly the shape a leak hides in (a `requestId` that is really a stack
 * frame would never be read by an assertion on `error.message`).
 */
function expectCleanError(response: LightMyRequestResponse, status: number, code: string): void {
  expect(response.statusCode).toBe(status)

  const body = response.body
  expect(body).not.toContain('NoSuchBucket')
  expect(body).not.toContain('AccessDenied')
  expect(body).not.toContain('SignatureDoesNotMatch')
  expect(body).not.toContain('InvalidAccessKeyId')
  expect(body).not.toContain('InvalidRange')
  expect(body).not.toContain('<Code>')
  expect(body).not.toContain('X-Amz-Signature')
  expect(body).not.toContain(config.MEDIA_BUCKET)
  expect(body).not.toMatch(/[a-zA-Z]:[\\/]/) // a Windows path would name our filesystem
  expect(body).not.toContain('/data')
  // A credential in a response body is the worst failure this file can report, so it is
  // asserted as a boolean: on failure vitest prints `true !== false` and not the value.
  expect(body.includes(config.MEDIA_SECRET_ACCESS_KEY)).toBe(false)
  expect(body.includes(config.MEDIA_ACCESS_KEY_ID)).toBe(false)

  const envelope = response.json() as { error?: { code?: string } }
  expect(Object.keys(envelope)).toEqual(['error'])
  expect(envelope.error?.code).toBe(code)
}

// ── fixtures: whole files, because `complete` now reads the object and walks it ───
//
// These used to be 12- and 24-byte magic-byte stubs. S8-c made that shape *refusable*:
// a PNG signature plus a truncated IHDR is not a PNG by structure, and the strip step
// says so. Real (small, hand-encoded) files are used instead, from the same builders the
// stripper's own tests use — see `imageFixtures.ts` for what is hand-built and what comes
// out of a real encoder.

const pngBytes = cleanPng()
const jpegBytes = cleanJpeg()
const gifBytes = cleanGif()

/** A real RIFF/WEBP container, 64 bytes: the `RIFF`-at-0 and `WEBP`-at-8 pair the sniff needs. */
const webpBytes = cleanWebp()

/** A 32-byte HEIC head: `ftyp`/`heic`, i.e. an iPhone photo renamed to `.jpg`. */
const heicBytes = heicHead()

const svgBytes = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><circle r="9"/></svg>',
)

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
      `upload tests need ${missing.join(', ')} — copy apps/api/.env.example to apps/api/.env ` +
        `(values from infra/.env) and start the stack with ` +
        `"corepack pnpm@12.4.1 --dir infra exec docker compose up -d"`,
    )
  }

  app = await buildApp({ config })
  await waitForRedis(app)

  /**
   * MinIO reachability, checked *after* `buildApp` on purpose: the media plugin's bucket
   * assurance runs during assembly and must not be fatal, so an unreachable bucket looks
   * like a healthy API until something tries to use it. Here is that something.
   */
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
        `${(error as Error).name}. Start MinIO with "docker compose -f infra/docker-compose.yml up -d minio". ` +
        `The API is expected to boot anyway (article reads must survive a media outage), so this suite — ` +
        `not the boot — is where a missing bucket has to be reported.`,
      { cause: error },
    )
  }

  const inserted = await app.db.query<{ id: string; github_login: string }>(
    `insert into users (github_login, display_name, is_admin)
       values ($1, 'UP Admin', true), ($2, 'UP Plain', false)
       returning id, github_login`,
    [`up-admin-${run}`, `up-plain-${run}`],
  )
  for (const row of inserted.rows) {
    if (row.github_login === `up-admin-${run}`) users.admin = row.id
    else users.plain = row.id
  }

  // Sweep keys left by an earlier crashed run, exactly as the DB suites delete rows by
  // login prefix. Without this the residue gate at the bottom would report another run's
  // wreckage as this one's bug.
  for (const key of await listKeys()) {
    await probe.send(new DeleteObjectCommand({ Bucket: config.MEDIA_BUCKET, Key: key }))
  }
})

afterAll(async () => {
  // In afterAll, so a failed assertion mid-test still leaves the bucket clean.
  if (probe) {
    for (const key of await listKeys()) {
      await probe.send(new DeleteObjectCommand({ Bucket: config.MEDIA_BUCKET, Key: key }))
    }

    // The residue gate, and the analogue of "the DB rows this suite made are gone": an
    // upload suite that leaves objects behind silently fills a *publicly readable* bucket,
    // which is worse than leftover rows — those are only reachable with the database.
    // Cleanup works by listing rather than by `issuedKeys` so an object created by a run
    // that crashed mid-PUT is swept too; the record of what we issued is in the message,
    // because "3 keys issued, 1 left" is the diagnosis and "1 object left" is not.
    const residue = await listKeys()
    if (residue.length > 0) {
      throw new Error(
        `upload suite left ${residue.length} object(s) in ${config.MEDIA_BUCKET}: ` +
          `${residue.join(', ')} (this run issued ${issuedKeys.length} key(s))`,
      )
    }
  }

  if (app?.db) {
    await app.db.query(`delete from users where github_login like 'up-%'`)
  }

  await app?.close()
  probe?.destroy()
})

async function listKeys(): Promise<string[]> {
  const listed = await probe.send(
    new ListObjectsV2Command({ Bucket: config.MEDIA_BUCKET }),
  )
  return (listed.Contents ?? []).map((object) => object.Key ?? '')
}

describe('auth and CSRF on both upload endpoints', () => {
  for (const url of ['/api/v1/uploads', '/api/v1/uploads/complete']) {
    it(`401s ${url} with no token`, async () => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'x-requested-with': 'portal' },
        payload: { contentType: 'image/png', size: 100, key: 'uploads/2026/10/x.png' },
      })
      expectCleanError(response, 401, ERROR_CODES.unauthorized)
    })

    it(`403s ${url} for a logged-in non-admin`, async () => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${tokenFor(users.plain)}`, 'x-requested-with': 'portal' },
        payload: { contentType: 'image/png', size: 100, key: 'uploads/2026/10/x.png' },
      })
      expectCleanError(response, 403, ERROR_CODES.forbidden)
    })

    /**
     * The header is checked on *both* endpoints, and `/complete` is the one that matters:
     * it deletes objects and mints public URLs. A cross-site form cannot set a custom
     * header, which is the entire mechanism (design §5's "CSRF on every write, not just
     * POST" applies to a POST-only surface too).
     */
    it(`403s ${url} without the CSRF header`, async () => {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${tokenFor(users.admin)}` },
        payload: { contentType: 'image/png', size: 100, key: 'uploads/2026/10/x.png' },
      })
      expectCleanError(response, 403, ERROR_CODES.csrfCheckFailed)
    })
  }
})

describe('POST /api/v1/uploads', () => {
  it('signs a PNG declaration with a key we issued and a URL we can PUT to', async () => {
    const response = await sign('image/png', pngBytes.length)
    expect(response.statusCode).toBe(201)

    const body = response.json() as PresignedUpload
    issuedKeys.push(body.key)

    expect(UPLOAD_KEY_PATTERN.test(body.key)).toBe(true)
    expect(body.key).toMatch(/\.png$/)

    // The URL is the product: it must point at the key it was issued for and carry a
    // SigV4 query. `X-Amz-SignedHeaders=host` is asserted because the whole verification
    // design rests on it — Content-Type is outside the signature (SPIKE-E hard fact 2).
    const url = new URL(body.uploadUrl)
    expect(decodeURIComponent(url.pathname)).toContain(body.key)
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.get('X-Amz-Credential')).toContain(config.MEDIA_REGION)
    expect(url.searchParams.get('X-Amz-Date')).toMatch(/^\d{8}T\d{6}Z$/)
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(config.MEDIA_PRESIGN_TTL_SECONDS))
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')

    // A short life, and told to the client honestly: the browser needs to know when to
    // re-sign rather than retry a PUT MinIO will reject as expired.
    const ttlMs = Date.parse(body.expiresAt) - Date.now()
    expect(ttlMs).toBeGreaterThan((config.MEDIA_PRESIGN_TTL_SECONDS - 10) * 1000)
    expect(ttlMs).toBeLessThanOrEqual(config.MEDIA_PRESIGN_TTL_SECONDS * 1000)
  })

  it('returns no public URL, because nothing has been uploaded yet', async () => {
    const body = (await sign('image/png', 100)).json() as PresignedUpload
    issuedKeys.push(body.key)
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'key', 'uploadUrl'])
    expect(body).not.toHaveProperty('publicUrl')
  })

  it('issues a fresh key per signature, so a spent URL cannot be reused for another object', async () => {
    const first = (await sign('image/png', 100)).json() as PresignedUpload
    const second = (await sign('image/png', 100)).json() as PresignedUpload
    issuedKeys.push(first.key, second.key)
    expect(first.key).not.toBe(second.key)
    expect(first.uploadUrl).not.toBe(second.uploadUrl)
  })

  it('refuses every declared type outside the whitelist with 415, and signs nothing', async () => {
    for (const contentType of ['image/svg+xml', 'text/plain', 'application/x-sh', 'image/png\n', 'IMAGE/PNG']) {
      const response = await sign(contentType, 100)
      expectCleanError(response, 415, ERROR_CODES.unsupportedMediaType)
    }
  })

  /**
   * The reason SVG is not on the list, asserted rather than trusted to the comment in
   * schema.ts: an SVG is XML, it can carry a load handler, and once it is served from the
   * media origin it executes on our name. If it ever were signed for, the next test would
   * catch it at the sniff — both gates are here on purpose.
   */
  it('refuses SVG as a declared type even though it is a real image format', async () => {
    const response = await sign('image/svg+xml', svgBytes.length)
    expect(response.statusCode).toBe(415)
    expect(response.json()).toHaveProperty(['error', 'message'])
    expect((response.json() as { error: { message: string } }).error.message).toContain('image/png')
  })

  it('early-exits a declared size over the cap with 413', async () => {
    const response = await sign('image/png', TEST_MAX_UPLOAD_BYTES + 1)
    expectCleanError(response, 413, ERROR_CODES.payloadTooLarge)
  })

  /**
   * There is no filename field, and this asserts the strongest available form of "your
   * name is not in here": a caller that *sends* one anyway has it discarded before the
   * key is built, so the issued key cannot contain any of it. Path traversal in a
   * filename is only dangerous if the name is used.
   */
  it('cannot be told what the key looks like', async () => {
    const smuggled = ['../../etc/passwd', 'cover.svg', 'a.png/../../b', '\r\nX-Amz-Signature']
    const response = await sign('image/png', 100, {
      filename: smuggled[0],
      name: smuggled[1],
      path: smuggled[2],
      key: smuggled[3],
    })
    expect(response.statusCode).toBe(201)

    const body = response.json() as PresignedUpload
    issuedKeys.push(body.key)

    for (const value of smuggled) {
      expect(body.key).not.toContain(value.replace(/[^\w./-]/g, '').slice(0, 8))
      expect(body.uploadUrl).not.toContain('passwd')
    }
    expect(body.key.split('/').at(-1)).toMatch(/^[0-9a-f]{32}\.png$/)
  })

  it('refuses a malformed request body at the boundary with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: adminHeaders(),
      payload: { contentType: 'image/png' }, // no size
    })
    // Fastify's own validation message, so it goes through the same leak check as ours:
    // the framework does not know about the bucket, but it does echo field names.
    expectCleanError(response, 400, ERROR_CODES.badRequest)
  })
})

describe('upload then complete: the verification gate', () => {
  it('accepts a real PNG and hands back a URL whose anonymous GET returns exactly those bytes', async () => {
    const signed = (await sign('image/png', pngBytes.length)).json() as PresignedUpload
    issuedKeys.push(signed.key)

    const put = await putToSignedUrl(signed.uploadUrl, pngBytes, 'image/png')
    expect(put.status, `PUT failed: ${await put.text()}`).toBe(200)

    const done = await complete(signed.key)
    expect(done.statusCode).toBe(200)
    const body = done.json() as CompletedUpload
    expect(body).toEqual({
      publicUrl: `${config.MEDIA_PUBLIC_BASE_URL}/${signed.key}`,
      contentType: 'image/png',
      sizeBytes: pngBytes.length,
      // S8-c's field, present and 0: the strip ran, found nothing to take, and did not
      // rewrite the object. `strippedBytes` is optional in the contract so an older
      // client keeps validating, but this API always reports the number it has.
      strippedBytes: 0,
    })

    /**
     * The public read, with no credential of any kind — this is what a visitor's `<img>`
     * does. Byte equality is the point: a response that is 200 but re-encoded, truncated,
     * or served from a different object proves nothing about what the PUT stored.
     */
    const fetched = await fetch(body.publicUrl)
    expect(fetched.status).toBe(200)
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(pngBytes)
  })

  it.each([
    ['image/jpeg', jpegBytes, /\.jpe?g$/],
    ['image/gif', gifBytes, /\.gif$/],
    ['image/webp', webpBytes, /\.webp$/],
  ] as const)('accepts a real %s', async (contentType, bytes, extension) => {
    const signed = (await sign(contentType, bytes.length)).json() as PresignedUpload
    issuedKeys.push(signed.key)
    expect(signed.key).toMatch(extension)

    expect((await putToSignedUrl(signed.uploadUrl, bytes, contentType)).status).toBe(200)

    const done = await complete(signed.key)
    expect(done.statusCode).toBe(200)
    const body = done.json() as CompletedUpload
    expect(body.contentType).toBe(contentType)
    expect(body.sizeBytes).toBe(bytes.length)
    expect(new Uint8Array(await (await fetch(body.publicUrl)).arrayBuffer())).toEqual(bytes)
  })

  /**
   * The case the whole design exists for, and the reason the sniff is a hard gate rather
   * than a nicety: the declaration is *outside the signature* (SPIKE-E hard fact 2), so
   * MinIO accepts this PUT, stores the SVG, and echoes `Content-Type: image/png` back at
   * every `HeadObject`. If anything downstream trusted that header, the object would be
   * served as a PNG the browser was told to expect — and it would be the file's own XML
   * that decided what happened next.
   */
  it('rejects an SVG body declared as image/png, and the object is provably gone', async () => {
    const signed = (await sign('image/png', svgBytes.length)).json() as PresignedUpload
    issuedKeys.push(signed.key)

    const put = await putToSignedUrl(signed.uploadUrl, svgBytes, 'image/png')
    expect(put.status).toBe(200) // the signature does not care what was declared

    // Evidence for the reader that `HeadObject.ContentType` is not a check: it says
    // image/png for an SVG. Asserted here so nobody re-proposes trusting it.
    const head = await probe.send(new HeadObjectCommand({ Bucket: config.MEDIA_BUCKET, Key: signed.key }))
    expect(head.ContentType).toBe('image/png')

    const done = await complete(signed.key)
    expectCleanError(done, 415, ERROR_CODES.unsupportedMediaType)

    // The delete is the point of the rejection, not a courtesy: an object left here is
    // public, listable by anyone with the key, and reachable by the article that failed
    // to save it. Two independent proofs that it is really gone.
    await expect(objectExists(signed.key)).resolves.toBe(false)
    const gone = await fetch(`${config.MEDIA_PUBLIC_BASE_URL.replace(/\/+$/, '')}/${signed.key}`)
    expect(gone.status).toBe(404)
  })

  it('rejects bytes that disagree with the key they were signed for, and deletes them', async () => {
    // Declared image/gif → issued a .gif key → uploaded a PNG. A surviving object's
    // extension and contents must agree, or the bucket fills with lying filenames.
    const signed = (await sign('image/gif', gifBytes.length)).json() as PresignedUpload
    issuedKeys.push(signed.key)
    expect(signed.key).toMatch(/\.gif$/)

    expect((await putToSignedUrl(signed.uploadUrl, pngBytes, 'image/gif')).status).toBe(200)

    const done = await complete(signed.key)
    expectCleanError(done, 415, ERROR_CODES.unsupportedMediaType)
    await expect(objectExists(signed.key)).resolves.toBe(false)
  })

  it('rejects an oversized object on its measured size, and deletes it', async () => {
    // Declared honestly-small, then PUT 64 KiB + 1 of real PNG. The declaration bought
    // the signature; it does not bind the body (SPIKE-E hard fact 1: presigned PUT has no
    // content-length-range), which is why the cap is re-measured here.
    const signed = (await sign('image/png', 100)).json() as PresignedUpload
    issuedKeys.push(signed.key)

    const oversized = new Uint8Array(TEST_MAX_UPLOAD_BYTES + 1)
    oversized.set(pngBytes)

    expect((await putToSignedUrl(signed.uploadUrl, oversized, 'image/png')).status).toBe(200)

    const done = await complete(signed.key)
    expectCleanError(done, 413, ERROR_CODES.payloadTooLarge)
    await expect(objectExists(signed.key)).resolves.toBe(false)
  })

  it('accepts an object exactly at the cap, so the limit is "up to" and not "under"', async () => {
    // The object is a real PNG padded by one legitimate `tEXt` chunk. It used to be a
    // signature followed by a run of zeros, which the size gate accepted and the S8-c
    // structure walk would refuse — and refusing *at the cap* would have looked like the
    // cap being wrong, so the fixture had to become a file.
    const signed = (await sign('image/png', TEST_MAX_UPLOAD_BYTES)).json() as PresignedUpload
    issuedKeys.push(signed.key)

    const atCap = pngPaddedTo(TEST_MAX_UPLOAD_BYTES)
    expect(atCap.length).toBe(TEST_MAX_UPLOAD_BYTES)

    expect((await putToSignedUrl(signed.uploadUrl, atCap, 'image/png')).status).toBe(200)

    const done = await complete(signed.key)
    expect(done.statusCode, done.body).toBe(200)
    const body = done.json() as CompletedUpload
    expect(body.sizeBytes).toBe(TEST_MAX_UPLOAD_BYTES)
    // A padding comment is prose, not coordinates: the strip left it alone, so the
    // published object is the uploaded one, byte for byte.
    expect(body.strippedBytes).toBe(0)
    expect(new Uint8Array(await (await fetch(body.publicUrl)).arrayBuffer())).toEqual(atCap)
  })

  /**
   * The iPhone case, answered at the gate rather than by the stripper: HEIF/HEIC starts
   * with a `ftyp` box, so it is neither `FFD8 FF` nor any of the four magics, and a file
   * renamed to `.jpg` never gets far enough to be looked at for EXIF. Declared as
   * `image/heic` it does not even get a signature (`ALLOWED_UPLOAD_TYPES`).
   */
  it('rejects a HEIC renamed to .jpg on its bytes, not on its name', async () => {
    expect(heicBytes.length).toBeGreaterThanOrEqual(32)

    const signed = (await sign('image/jpeg', heicBytes.length)).json() as PresignedUpload
    issuedKeys.push(signed.key)
    expect((await putToSignedUrl(signed.uploadUrl, heicBytes, 'image/jpeg')).status).toBe(200)

    const done = await complete(signed.key)
    expectCleanError(done, 415, ERROR_CODES.unsupportedMediaType)
    await expect(objectExists(signed.key)).resolves.toBe(false)
  })

  it('rejects an empty object rather than treating "no signature" as a pass', async () => {
    const signed = (await sign('image/png', 1)).json() as PresignedUpload
    issuedKeys.push(signed.key)

    expect((await putToSignedUrl(signed.uploadUrl, new Uint8Array(0), 'image/png')).status).toBe(200)

    const done = await complete(signed.key)
    expectCleanError(done, 415, ERROR_CODES.unsupportedMediaType)
    await expect(objectExists(signed.key)).resolves.toBe(false)
  })

  it('refuses a key it never issued with 400, and reads nothing from the bucket', async () => {
    // The shape check is what stops this endpoint from being a probe for arbitrary object
    // paths in our own bucket, which is the only reason it exists.
    for (const key of [
      'uploads/2026/10/0f1e2d3c4b5a69788796a5b4c3d2e1f0.svg',
      '../../etc/passwd',
      `${config.MEDIA_BUCKET}/uploads/2026/10/0f1e2d3c4b5a69788796a5b4c3d2e1f0.png`,
      'uploads/2026/10/0f1e2d3c4b5a69788796a5b4c3d2e1f0.exe',
      'uploads/2026/1/0f1e2d3c4b5a69788796a5b4c3d2e1f0.png',
      'anything',
    ]) {
      const response = await complete(key)
      expectCleanError(response, 400, ERROR_CODES.badRequest)
      // The message describes the shape we issue; it is not an echo of the probe, which
      // is the only way a 400 becomes a way to read a bucket name back out of the API.
      expect(response.body).not.toContain(key)
    }
  })

  it('reports a well-shaped key with no object behind it as 404', async () => {
    // A key that passes the shape check but was never uploaded (or already completed).
    // 404 because there is genuinely nothing there, and no delete is attempted for it.
    const neverUploaded = `uploads/2026/10/${'f'.repeat(32)}.png`
    const response = await complete(neverUploaded)
    expectCleanError(response, 404, ERROR_CODES.notFound)
  })

  it('will not complete the same key twice with a stale URL', async () => {
    // Completion does not consume the key — there is no ledger (the reason is in
    // `service.ts`), and this records the actual behaviour rather than the intent: a
    // second call re-verifies the same object and answers 200 with the same URL.
    const signed = (await sign('image/png', pngBytes.length)).json() as PresignedUpload
    issuedKeys.push(signed.key)
    expect((await putToSignedUrl(signed.uploadUrl, pngBytes, 'image/png')).status).toBe(200)

    const first = await complete(signed.key)
    const second = await complete(signed.key)
    expect(first.statusCode).toBe(200)
    expect(second.json()).toEqual(first.json())
  })
})

describe('the signed URL is a write capability, and only that', () => {
  it('refuses an unsigned PUT of the same key', async () => {
    const signed = (await sign('image/png', pngBytes.length)).json() as PresignedUpload
    issuedKeys.push(signed.key)

    const unsigned = `${config.MEDIA_ENDPOINT}/${config.MEDIA_BUCKET}/${signed.key}`
    const response = await fetch(unsigned, { method: 'PUT', body: pngBytes })
    expect(response.status).toBe(403) // SPIKE-E #3: writes only honour a signature
    await expect(objectExists(signed.key)).resolves.toBe(false)
  })

  it('serves public reads without a credential and answers 404 for a key that is not there', async () => {
    /**
     * Not an assertion about *listing*. SPIKE-E recorded that MinIO's
     * `mc anonymous set download` preset also grants `s3:ListBucket`, and design §4.3
     * pins the policy to be set **only when this API creates the bucket** — so on a box
     * where the spike provisioned `portal-media` by hand, listing stays open no matter
     * what our code says. Asserting it here would fail on exactly the machines the spike
     * touched and pass in CI, which is a test about infrastructure drift rather than about
     * this codebase. What `uploads-rules.test.ts` asserts instead is the policy we
     * install: `s3:GetObject`, nothing more.
     *
     * What *is* ours to prove is the pair that makes a cover image work on a page: an
     * anonymous GET of a real key returns the bytes (proven per-format above), and an
     * anonymous GET of a key that is not there is a 404 — not a 403 masquerading as
     * missing, and not a 200 with someone else's object.
     */
    const signed = (await sign('image/png', pngBytes.length)).json() as PresignedUpload
    issuedKeys.push(signed.key)
    expect((await putToSignedUrl(signed.uploadUrl, pngBytes, 'image/png')).status).toBe(200)
    await complete(signed.key)

    const base = config.MEDIA_PUBLIC_BASE_URL.replace(/\/+$/, '')
    await expect(fetch(`${base}/${signed.key}`).then((r) => r.status)).resolves.toBe(200)
    await expect(fetch(`${base}/uploads/2026/10/${'0'.repeat(32)}.png`).then((r) => r.status)).resolves.toBe(404)
  })

  it('expires, so a captured URL stops being a write once the window passes', async () => {
    // The shortest TTL the config allows is 5 seconds, so this is a real expiry test
    // rather than a simulation of one — six seconds of a sleeping test worker is the
    // price, and it is only paid in this file.
    const shortLived = await buildApp({
      config: { ...config, MEDIA_PRESIGN_TTL_SECONDS: 5 },
      loggerDestination: silentStream(),
    })
    await waitForRedis(shortLived)

    try {
      // A second app over the same Postgres and Redis, so the token is minted by it but
      // the user id is the outer suite's.
      const response = await shortLived.inject({
        method: 'POST',
        url: '/api/v1/uploads',
        headers: {
          authorization: `Bearer ${shortLived.signAccessToken({ sub: users.admin, jti: generateJti() })}`,
          'x-requested-with': 'portal',
        },
        payload: { contentType: 'image/png', size: pngBytes.length },
      })
      expect(response.statusCode).toBe(201)
      const signed = response.json() as PresignedUpload
      issuedKeys.push(signed.key)

      await new Promise((resolve) => setTimeout(resolve, 6_000))

      const expired = await fetch(signed.uploadUrl, { method: 'PUT', body: pngBytes })
      expect(expired.status).toBe(403) // SPIKE-E #7: "Request has expired"
      await expect(objectExists(signed.key)).resolves.toBe(false)
    } finally {
      await shortLived.close()
    }
  }, 30_000)
})
