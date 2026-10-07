import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor, InvalidCursorError } from './pagination.js'

const cursor = { p: '2026-09-21T10:00:00.123456Z', i: 'ed79c04f-27e0-43ef-b316-575339b76453' }

describe('cursor encoding', () => {
  it('round-trips a real key', () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor)
  })

  it('is opaque enough to survive URL transport', () => {
    // base64url, so it must not need percent-encoding: no '+', '/' or '=' — the
    // cursor is appended straight into a query string by clients.
    const encoded = encodeCursor(cursor)

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(encodeURIComponent(encoded)).toBe(encoded)
  })

  it.each([
    ['not base64/json at all', 'not-a-real-cursor'],
    ['empty object', btoaURL('{}')],
    ['missing i', btoaURL(JSON.stringify({ p: cursor.p }))],
    ['p not a string', btoaURL(JSON.stringify({ p: 5, i: cursor.i }))],
    ['p not a timestamp', btoaURL(JSON.stringify({ p: 'yesterday', i: cursor.i }))],
    ['array rather than object', btoaURL(JSON.stringify([cursor.p, cursor.i]))],
    ['null', btoaURL('null')],
  ])('rejects %s', (_label, raw) => {
    expect(() => decodeCursor(raw)).toThrow(InvalidCursorError)
  })

  it('rejects a cursor whose tie-breaker is not a uuid-shaped string it can bind', () => {
    // `i` is cast to ::uuid by the query. A malformed value would otherwise blow up
    // deep in Postgres as a 500 instead of being refused as a 400.
    expect(() => decodeCursor(btoaURL(JSON.stringify({ p: cursor.p, i: 'not-a-uuid' })))).toThrow(
      InvalidCursorError,
    )
  })
})

function btoaURL(json: string): string {
  return Buffer.from(json, 'utf8').toString('base64url')
}
