/**
 * The storage port for media objects — four methods, and the count is deliberate.
 *
 * Why a port at all: the interesting rules of stage F (which declared type buys
 * which extension, what a key may look like, whether the bytes agree with it, when
 * an object must be deleted) are pure decisions about strings and numbers. Routing
 * them through a real S3 client would make every one of those assertions need a
 * network and a bucket, and the failure branches that matter most — a rejected
 * object must not survive — would end up tested only by whoever remembers to. With
 * this seam the rules run against a stand-in in microseconds, and the real MinIO
 * suite is left to prove the one thing a fake cannot: that a signature MinIO accepts
 * really does produce an object whose bytes say what we sniffed.
 *
 * `ListObjects`, `CreateBucket` and `PutBucketPolicy` are *not* on this port. The
 * upload surface has no reason to enumerate a bucket, and bucket-shape work belongs to
 * startup rather than to a request. Keeping them off is what stops the rules layer from
 * being able to reach them.
 *
 * **Writes, and the one that is allowed.** This port used to read "writes only ever
 * happen with a browser holding a signature", and that is still true of *uploads*: the
 * PUT that creates an object is signed for one key for sixty seconds and the API never
 * sees those bytes, which is exactly why `complete` has to verify after the fact.
 * `replace` is a different capability and is named as one: the server rewriting an
 * object it has just measured, in the same request that measured it, because a photo's
 * EXIF can carry the owner's coordinates and the bucket is publicly readable
 * (`lib/imageMetadata.ts`, stage S8-c). What the shape of this port now protects is that
 * no caller can create a key it did not sign for or write anywhere it has not just
 * read, so the rules that keep `replace` narrow live in `UploadService.complete`, its
 * only caller: the key has passed the strict shape check, the object's real size and
 * magic bytes have come from the bucket, and the bytes written back are that object's
 * own bytes with segments cut out of them.
 */

/** What `presignPut` hands back: a capability with a deadline, nothing more. */
export interface PresignedPut {
  /** Fully-formed, signed, PUT-able URL — including the `X-Amz-*` query. */
  uploadUrl: string
  /** The signature's own expiry, ISO 8601, read off the URL that was signed. */
  expiresAt: string
}

/**
 * What the server measured about an object: its real size and its leading bytes.
 *
 * One method, both facts, because verification needs both at once — and because
 * splitting them would let a caller compare a size from one moment against bytes
 * from another, which is precisely the window in which an object can be replaced.
 *
 * `head` may be shorter than the requested count when the object is smaller than
 * that (a 4-byte file has 4 bytes), and empty for a 0-byte object. That is the
 * transport's honest report, not a truncation to work around.
 *
 * Asking for a count at or above the object's size returns **the whole object**, and
 * the strip step relies on that rather than on a second method: an EXIF segment begins
 * past where a 32-byte sniff can see (`imageMetadata.test.ts` measures the coordinates
 * at byte 141 of an 827-byte fixture), and the size gate has already bounded the request
 * to `MEDIA_MAX_UPLOAD_BYTES`. One method also keeps the pair atomic — the bytes a
 * caller strips are the bytes whose size it just measured, from the same round trip.
 */
export interface ObjectInspection {
  /** `ContentLength` as the storage server reported it, in bytes. */
  sizeBytes: number
  /** Up to `headBytes` leading bytes of the object, exactly as stored. */
  head: Uint8Array
}

export interface MediaStore {
  /**
   * Sign a PUT for `key`, valid for `ttlSeconds`.
   *
   * `contentType` is what the *client claimed* and it is only used to satisfy the
   * signature's own shape; it is not stored as a guarantee. With
   * `X-Amz-SignedHeaders=host` — the only form the browser can use here — the
   * declared type is outside the signature, so whatever the PUT says is what the
   * object will report back. Nothing downstream may treat it as evidence.
   */
  presignPut(key: string, contentType: string, ttlSeconds: number): Promise<PresignedPut>

  /** Measure an object and read its leading bytes. Rejects if it is not there. */
  inspect(key: string, headBytes: number): Promise<ObjectInspection>

  /**
   * Overwrite `key` with `bytes`, which the caller must have read from that same key.
   *
   * The only server-side write on the port, and the only one whose `Content-Type` is
   * worth believing: `complete` passes the type it *measured from the bytes*, not the
   * client's declaration, so an object that survives this call stops advertising
   * whatever the browser claimed about it.
   *
   * **Rejects** — unlike `remove`, which is best-effort — because the caller's answer
   * depends on whether the rewrite happened. A failed rewrite leaves the object in place
   * with its metadata intact, so reporting success would be the one wrong outcome;
   * `UploadService.complete` catches this, deletes the object, and refuses the upload.
   * Every failure is translated into an `ApiError` before it gets here, as with every
   * other storage call.
   */
  replace(key: string, bytes: Uint8Array, contentType: string): Promise<void>

  /**
   * Delete `key`, best-effort.
   *
   * Never rejects. `DeleteObject` is already idempotent for a missing key, so the
   * only failures left are ours (credentials, network) — and reporting one as a
   * thrown error would replace the 415 or 413 that is the *caller's* answer with a
   * 500 about our infrastructure. The object being refused is refused either way;
   * a failure to remove it is logged loudly instead, and the residue assertion in
   * the integration suite is what catches it in CI.
   */
  remove(key: string): Promise<void>
}
