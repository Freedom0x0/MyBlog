/**
 * The storage port for media objects — three methods, and the count is deliberate.
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
 * `ListObjects`, `PutObject`, `CreateBucket` and friends are *not* on this port. The
 * upload surface has no reason to enumerate a bucket, and writes only ever happen
 * with a browser holding a signature. The bucket-creation calls the startup
 * assurance makes live in `s3-store.ts` for the same reason they are not here: the
 * rules layer must not be able to reach them.
 */

/** What `presignPut` hands back: a capability with a deadline, nothing more. */
export interface PresignedPut {
  /** Fully-formed, signed, PUT-able URL — including the `X-Amz-*` query. */
  uploadUrl: string
  /** The signature's own expiry, ISO 8601, read off the URL that was signed. */
  expiresAt: string
}

/**
 * What the server measured about an object: its real size and its first bytes.
 *
 * One method, both facts, because verification needs both at once — and because
 * splitting them would let a caller compare a size from one moment against bytes
 * from another, which is precisely the window in which an object can be replaced.
 *
 * `head` may be shorter than the requested count when the object is smaller than
 * that (a 4-byte file has 4 bytes), and empty for a 0-byte object. That is the
 * transport's honest report, not a truncation to work around.
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
