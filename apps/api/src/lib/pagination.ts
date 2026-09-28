/**
 * Keyset ("cursor") pagination.
 *
 * Why not OFFSET: `limit 10 offset 10000` still makes the database produce and
 * discard ten thousand rows, so page N costs more than page N-1 — the list
 * endpoint degrades as content accumulates. A keyset predicate seeks straight to
 * the position in the index instead.
 *
 * The cursor is base64url of the sort key, deliberately opaque. Once a client
 * parses it, changing the encoding becomes a breaking API change; keeping it
 * encoded is what buys the freedom to change it.
 */

/** The sort key of the public article list: `(published_at desc, id desc)`. */
export interface Cursor {
  /** ISO timestamp of the last row on the previous page. */
  p: string
  /** Its id, the tie-breaker that makes the ordering total. */
  i: string
}

export class InvalidCursorError extends Error {
  constructor(reason: string) {
    super(`Invalid cursor: ${reason}`)
    this.name = 'InvalidCursorError'
  }
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/**
 * Decodes and validates the shape.
 *
 * Every rejection here is a client sending a tampered or stale value, so it must
 * surface as a 400 — never as a 500 from a crashed query, and never as "treat it
 * as no cursor", which would silently restart the walk at page one and duplicate
 * rows a client already saw.
 */
export function decodeCursor(raw: string): Cursor {
  let parsed: unknown

  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new InvalidCursorError('not decodable')
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidCursorError('not an object')
  }

  const candidate = parsed as Record<string, unknown>

  if (typeof candidate.p !== 'string' || typeof candidate.i !== 'string') {
    throw new InvalidCursorError('missing p or i')
  }

  // An unparseable timestamp would make the row-value comparison throw deep in
  // Postgres; checking here turns that into a 400.
  if (Number.isNaN(Date.parse(candidate.p))) {
    throw new InvalidCursorError('p is not a timestamp')
  }

  // `i` is bound as ::uuid. Validating it here is what keeps a malformed cursor a
  // 400 instead of a database error surfacing as a 500.
  if (!UUID_RE.test(candidate.i)) {
    throw new InvalidCursorError('i is not a uuid')
  }

  return { p: candidate.p, i: candidate.i }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
