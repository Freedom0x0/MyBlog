import { apiPost } from '../lib/apiClient'
import type { CompletedUpload, CompleteUploadInput, PresignedUpload, RequestUploadInput } from 'shared'

/**
 * Cover-image uploads: the two portal calls around a direct PUT to the object store.
 *
 * Its own file rather than a corner of {@link ./articlesApi} because the endpoint
 * family is `/uploads`, not `/articles`, and the thing it returns is not an article —
 * it is a capability (`uploadUrl`) and then a verdict (`publicUrl`). The article field
 * it eventually lands in is a one-line concern of the caller.
 *
 * The three steps exist because the browser cannot be trusted about the file it is
 * holding, and the API is written on that assumption:
 *
 * 1. `POST /uploads` signs a 60-second PUT for a key *this server* chose. The
 *    declared `contentType` only picks the key's extension; the declared `size` only
 *    saves us from signing something we would refuse anyway. Neither is binding
 *    (`X-Amz-SignedHeaders=host` leaves both unsigned — SPIKE-E hard fact 2).
 * 2. The PUT itself goes to MinIO through `putPresignedObject`, never through this
 *    file: see the header comment there for the three portal-client behaviours that
 *    would be wrong on that request.
 * 3. `POST /uploads/complete` reads the object's bytes back and answers with the
 *    measured type and size. That is the first URL worth storing, and the only place
 *    worth reading a size from. A refused object is deleted by the server, so a
 *    failure leaves nothing for the person uploading to clean up.
 *
 * There is no filename in any of these bodies and no plan to add one: the API refuses
 * user-supplied names (collision and path traversal both start there), so nothing here
 * should grow a `name` field to be helpful.
 */

/**
 * The types this API will sign for — a copy of `ALLOWED_UPLOAD_TYPES` in
 * `apps/api/src/modules/uploads/schema.ts`, and a copy on purpose: the shared package
 * keeps that table server-side (it is where the key extension comes from), so the
 * browser's only legitimate use is the pre-flight below. SVG is missing from the list
 * by design, not by oversight — see the comment on that table.
 */
export const ALLOWED_UPLOAD_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

/**
 * The size the pre-flight assumes, mirroring `MEDIA_MAX_UPLOAD_BYTES` (default 5 MiB;
 * `apps/api/src/config/index.ts`, overridable in `apps/api/.env`).
 *
 * **This is not the limit.** The limit is the server re-measuring the object with
 * `HeadObject` in `complete`, and it answers 413 there. Because this constant is a
 * guess at a deploy-time configuration value, it can only ever be wrong in one
 * direction that matters: a deployment that *raises* the cap gets a page that refuses
 * uploads the server would have accepted. Anyone who changes `MEDIA_MAX_UPLOAD_BYTES`
 * has to change this number in the same pass — grep for this name from there.
 */
export const MAX_UPLOAD_BYTES_HINT = 5 * 1024 * 1024

/** Membership test for the pre-flight, written as a function so the list above stays the single copy. */
export function isAllowedContentType(value: string): boolean {
  return (ALLOWED_UPLOAD_CONTENT_TYPES as readonly string[]).includes(value)
}

/**
 * `POST /api/v1/uploads` → 201 with a single-use, 60-second PUT capability.
 *
 * Admin-only and CSRF-protected like every other write, which `apiPost` handles by
 * deriving the header from the method. The response carries **no** public URL: the
 * object does not exist yet and may never exist, so a URL from here would be a
 * promise this endpoint cannot keep.
 */
export async function requestUpload(contentType: string, size: number): Promise<PresignedUpload> {
  const input: RequestUploadInput = { contentType, size }
  return apiPost<PresignedUpload>('/uploads', input)
}

/**
 * `POST /api/v1/uploads/complete` → 200 with the storable URL.
 *
 * `contentType` and `sizeBytes` in the answer are the server's own measurements from
 * the object's bytes, not an echo of what was declared — so they are the numbers worth
 * showing a person. 415 (bytes are not one of the four formats, or disagree with the
 * key they were signed for) and 413 (over the cap) both delete the object first; 400
 * means the key is not one this API issued.
 */
export async function completeUpload(key: string): Promise<CompletedUpload> {
  const input: CompleteUploadInput = { key }
  return apiPost<CompletedUpload>('/uploads/complete', input)
}
