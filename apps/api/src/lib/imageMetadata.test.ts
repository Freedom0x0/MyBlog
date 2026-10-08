import { describe, expect, it } from 'vitest'
import { inflateSync } from 'node:zlib'
import { ImageParseError, stripImageMetadata } from './imageMetadata.js'
import {
  asciiBytes,
  buildWebp,
  cleanGif,
  cleanJpeg,
  cleanPng,
  cleanWebp,
  containsSequence,
  exifTiffWithGps,
  EXIF_IDENTIFIER_BYTES,
  gifWithExifApplication,
  gifWithXmpApplication,
  gpsCoordinateBytes,
  indexOfBytes,
  jpegApp1PastEnd,
  jpegApp13Photoshop,
  jpegApp1Exif,
  jpegApp1Xmp,
  jpegConcatenated,
  jpegScanTail,
  jpegStartOfFrame,
  jpegWith,
  jpegWithExifAfterScan,
  jpegWithGpsExif,
  jpegWithoutScan,
  pngChunk,
  pngIhdr,
  pngIdat,
  pngTextComment,
  pngWith,
  pngWithBadCrc,
  PNG_SIGNATURE,
  pngWithChunkAfterIend,
  pngWithChunkPastEnd,
  pngWithGpsExif,
  pngWithWrongChunkOrder,
  pngWithXmpText,
  riffChunk,
  vp8xChunk,
  webpWithExifAndXmp,
  webpWithGpsExif,
} from '../test/imageFixtures.js'

/**
 * The metadata stripper, unit level (S8-c).
 *
 * These are the assertions the byte surgery has to survive: that the coordinates left,
 * that the picture did not move, and that a file whose structure stops making sense is
 * refused instead of waved through. `src/test/uploads-strip.test.ts` drives the same
 * code through a real MinIO and an anonymous GET; this file is where the four formats
 * and the malformed branches are actually enumerated, because a bucket cannot produce a
 * JPEG whose APP1 length lies about itself on demand.
 *
 * **One thing no test here can prove, stated where it belongs**: the fixtures embed a
 * real encoder's picture data (see `test/imageFixtures.ts`), so "the stripped file still
 * decodes" is a claim a third-party decoder can check — and one was used, out-of-band,
 * against Pillow 12.3.0 on this machine (decode input and output, compare every pixel
 * sample, confirm the GPS IFD is unreadable afterwards). It is reported with the stage
 * rather than committed here because CI has no Python, and a test that silently skips
 * when its oracle is missing is worse than no test.
 */

const GPS = gpsCoordinateBytes()

describe('JPEG: the marker chain before the scan', () => {
  const file = jpegWithGpsExif()

  it('puts the GPS far outside the 32 bytes the completion check already reads, which is why the object is now read whole', () => {
    // Stage F's gate sniffs 32 bytes and that is still the right size for *its* job. For
    // this one it is not enough, and the arithmetic is the argument: the `Exif\0\0`
    // identifier is at 4 here, but the segment's own length field says 194 bytes and the
    // coordinates live at 144 — inside the payload, past anything a leading window can
    // reach. In a phone file the APP1 is 5–50 KB and the encoder's own APP0 sits in front
    // of it, so even the identifier can be outside the window. A head read cannot tell
    // "this APP1 has no GPS IFD" from "this APP1 has one", which is the whole question.
    const exif = jpegApp1Exif()
    expect(indexOfBytes(file, GPS)).toBeGreaterThan(32)
    expect(indexOfBytes(file, EXIF_IDENTIFIER_BYTES) + exif.length).toBeGreaterThan(32)
    expect(exif.length).toBeGreaterThan(190)
    // …and the coordinates are in the object at all, so the assertions below can be
    // read as "removed" rather than "were never there".
    expect(containsSequence(file.subarray(0, 32), GPS)).toBe(false)
    expect(containsSequence(file, GPS)).toBe(true)
  })

  it('removes the GPS with the APP1 that carried it', () => {
    expect(containsSequence(file, GPS)).toBe(true) // before

    const result = stripImageMetadata(file, 'image/jpeg')

    expect(result.containers).toEqual(['APP1/Exif'])
    expect(result.removedBytes).toBeGreaterThan(0)
    expect(containsSequence(result.bytes, GPS)).toBe(false)
    expect(containsSequence(result.bytes, EXIF_IDENTIFIER_BYTES)).toBe(false)
    // stripped twice is stable, so a re-upload of a stored object cannot lose more bytes
    expect(stripImageMetadata(result.bytes, 'image/jpeg').removedBytes).toBe(0)
    expect(result.format).toBe('JPEG')
  })

  it('keeps the compressed image data byte for byte, and the markers that describe it', () => {
    const result = stripImageMetadata(file, 'image/jpeg')
    const kept = result.bytes

    // The scan tail — start-of-scan marker, entropy-coded data, end-of-image — is copied
    // as one block, so byte equality here is the whole "we did not re-encode" claim in a
    // single assertion.
    expect(kept.subarray(indexOfBytes(kept, Uint8Array.from([0xff, 0xda])))).toEqual(jpegScanTail(file))

    // SOF0 is where the dimensions live; comparing the segment rather than a parsed
    // number also proves precision, component count and sampling factors did not move.
    expect(jpegStartOfFrame(kept)).toEqual(jpegStartOfFrame(file))

    expect(kept[0]).toBe(0xff)
    expect(kept[1]).toBe(0xd8) // SOI
    expect(kept.subarray(kept.length - 2)).toEqual(Uint8Array.from([0xff, 0xd9])) // EOI last
    expect(kept.length).toBe(file.length - result.removedBytes)
  })

  it('keeps every non-APP1 segment, including APP13 text that is not coordinates', () => {
    const app1 = jpegApp1Exif()
    const app13 = jpegApp13Photoshop()
    const source = jpegWith(app1, app13)
    const result = stripImageMetadata(source, 'image/jpeg')

    expect(result.containers).toEqual(['APP1/Exif'])
    expect(containsSequence(result.bytes, app13)).toBe(true)
    // …at exactly the offset it would have had if only the EXIF had been cut out, i.e.
    // nothing else shifted by even one byte.
    expect(indexOfBytes(result.bytes, app13)).toBe(indexOfBytes(source, app13) - app1.length)
    expect(result.removedBytes).toBe(app1.length)
  })

  it('drops XMP-carrying APP1 too, because XMP defines coordinate tags', () => {
    const source = jpegWith(jpegApp1Xmp())
    const result = stripImageMetadata(source, 'image/jpeg')

    expect(result.containers).toEqual(['APP1/XMP'])
    expect(containsSequence(result.bytes, asciiBytes('GPSLatitude'))).toBe(false)
    expect(result.bytes.subarray(indexOfBytes(result.bytes, Uint8Array.from([0xff, 0xda])))).toEqual(jpegScanTail(source))
  })

  it('drops an APP1 whose identifier is neither EXIF nor XMP rather than assume it is harmless', () => {
    const unidentified = Uint8Array.from([0xff, 0xe1, 0x00, 0x0a, ...asciiBytes('ABCDEFGH')])
    const result = stripImageMetadata(jpegWith(unidentified), 'image/jpeg')

    expect(result.containers).toEqual(['APP1/unidentified'])
    expect(result.removedBytes).toBe(unidentified.length)
  })

  it('leaves a JPEG that has no metadata exactly as it arrived', () => {
    // The negative control, and the only assertion here that guards against the stripper
    // being a mangler: a clean file must come back as *the same array*, not an equal one.
    const source = cleanJpeg()
    const result = stripImageMetadata(source, 'image/jpeg')

    expect(result.bytes).toBe(source)
    expect(result.removedBytes).toBe(0)
    expect(result.containers).toEqual([])
  })

  it('survives fill bytes before a marker, which real writers emit', () => {
    // `FF FF E1` is legal (T.81 allows fill bytes before a marker id) and a walk that
    // assumes exactly one `FF` desynchronises from here on — losing every segment after
    // it, including the metadata one it was trying to find.
    const padded = Uint8Array.from([0xff, ...jpegApp1Exif()])
    const result = stripImageMetadata(jpegWith(padded), 'image/jpeg')

    expect(result.containers).toEqual(['APP1/Exif'])
    expect(containsSequence(result.bytes, GPS)).toBe(false)
  })
})

describe('JPEG: structures that must be refused, not passed through', () => {
  function refuses(bytes: Uint8Array, fragment: RegExp): void {
    let caught: unknown
    try {
      stripImageMetadata(bytes, 'image/jpeg')
    } catch (error) {
      caught = error
    }
    expect(caught, 'expected an ImageParseError, none was thrown').toBeInstanceOf(ImageParseError)
    expect((caught as ImageParseError).format).toBe('JPEG')
    expect((caught as ImageParseError).message).toMatch(fragment)
  }

  it('refuses an APP1 whose declared length runs past the end of the file', () => {
    refuses(jpegApp1PastEnd(), /past the end of the file/)
  })

  it('refuses a JPEG with markers and no scan data', () => {
    // Every segment in it is well-formed and there is no picture. This is the shape the
    // *previous* fixtures had, which is the honest way to say what stage F used to
    // accept: a 12-byte JPEG stub passed the sniff and now passes nothing.
    refuses(jpegWithoutScan(), /start-of-scan/)
  })

  it('refuses a JPEG with an EXIF block after the image data', () => {
    refuses(jpegWithExifAfterScan(), /past the start-of-scan marker/)
  })

  it('refuses two JPEGs concatenated, because the second one is a container nobody walked', () => {
    refuses(jpegConcatenated(), /past the start-of-scan marker/)
  })

  it('refuses a file that does not start with SOI, a stray FF00, a truncated length field, and trailing fill bytes', () => {
    refuses(Uint8Array.from([0x00, 0x01, 0xff, 0xda, 0x00, 0x02]), /does not begin with FFD8/)
    refuses(Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0xda]), /FF00/)
    refuses(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), /no length field/)
    refuses(Uint8Array.from([0xff, 0xd8, 0xff, 0xff]), /fill bytes/)
    refuses(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]), /marker chain ends before/)
  })

  it('refuses a segment whose length field is smaller than itself', () => {
    refuses(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0x4a]), /shorter than the two bytes/)
  })

  it('refuses a second SOI inside the header, which is a crafted file and not a nested image', () => {
    refuses(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd8, 0xff, 0xda]), /two JPEGs concatenated/)
  })
})

describe('PNG: chunks', () => {
  it('removes the eXIf chunk and keeps IHDR, IDAT and IEND byte for byte', () => {
    const file = pngWithGpsExif()
    expect(containsSequence(file, GPS)).toBe(true)

    const result = stripImageMetadata(file, 'image/png')

    expect(result.containers).toEqual(['eXIf chunk (EXIF)'])
    expect(containsSequence(result.bytes, GPS)).toBe(false)
    expect(containsSequence(result.bytes, EXIF_IDENTIFIER_BYTES)).toBe(false)

    const kept = result.bytes
    expect(kept.subarray(0, 8)).toEqual(PNG_SIGNATURE)
    // Every chunk we promised to keep is still there *whole*: the slice includes the
    // length field and the CRC, so a deletion window off by one byte cannot pass this.
    for (const type of ['IHDR', 'IDAT', 'IEND']) {
      expect(pngChunkOf(kept, type)).toEqual(pngChunkOf(file, type))
    }
    // and the pixel data still inflates to the same 8 scanlines it always did
    expect(inflateSync(pngChunkPayload(kept, 'IDAT'))).toEqual(inflateSync(pngChunkPayload(file, 'IDAT')))
    expect(stripImageMetadata(kept, 'image/png').removedBytes).toBe(0)
  })

  it('removes an XMP text chunk, which is the other way a PNG can hold coordinates', () => {
    const file = pngWithXmpText()
    const result = stripImageMetadata(file, 'image/png')

    expect(result.containers).toEqual(['iTXt/XMP'])
    expect(containsSequence(result.bytes, asciiBytes('GPSLatitude'))).toBe(false)
    expect(pngChunkOf(result.bytes, 'IDAT')).toEqual(pngChunkOf(file, 'IDAT'))
  })

  it('keeps a tEXt comment, because prose is not a coordinate pair and dropping it would delete licensing text', () => {
    const file = pngWith(
      pngChunk('IHDR', pngIhdr()),
      pngTextComment(),
      pngChunk('IDAT', pngIdat()),
      pngChunk('IEND', new Uint8Array(0)),
    )
    const result = stripImageMetadata(file, 'image/png')

    expect(result.containers).toEqual([])
    expect(result.bytes).toBe(file)
    // Stated plainly so nobody reads this test as "all text is gone": a place name in a
    // Comment survives this stripper, on purpose.
    expect(containsSequence(result.bytes, asciiBytes('kitchen'))).toBe(true)
  })

  it('drops an EXIF chunk however the file capitalises its name', () => {
    // `eXIf` is the registered chunk name; a different case is invalid PNG but is exactly
    // what an evader would write, and a byte-equality comparison would wave it through.
    for (const type of ['eXIf', 'EXIF', 'exif']) {
      const file = pngWith(
        pngChunk('IHDR', pngIhdr()),
        pngChunk(type, exifTiffWithGps()),
        pngChunk('IDAT', pngIdat()),
        pngChunk('IEND', new Uint8Array(0)),
      )
      const result = stripImageMetadata(file, 'image/png')

      expect(result.containers, type).toEqual([`${type} chunk (EXIF)`])
      expect(containsSequence(result.bytes, GPS), type).toBe(false)
    }
  })

  it('leaves a metadata-free PNG untouched', () => {
    const file = cleanPng()
    const result = stripImageMetadata(file, 'image/png')

    expect(result.bytes).toBe(file)
    expect(result.removedBytes).toBe(0)
  })

  it('refuses a chunk whose CRC does not match its bytes, because chunk boundaries are what we cut on', () => {
    expect(() => stripImageMetadata(pngWithBadCrc(), 'image/png')).toThrow(/CRC of the IHDR chunk does not match/)
  })

  it('refuses a valid PNG whose chunks are in an order the spec forbids', () => {
    // gAMA before IHDR: every chunk is well-formed and CRC-correct, so a parser that
    // only needs "some IHDR somewhere" would publish it. Being refused is the point.
    expect(() => stripImageMetadata(pngWithWrongChunkOrder(), 'image/png')).toThrow(/first chunk must be IHDR/)
  })

  it('refuses a chunk that declares more bytes than the file holds, and a file that ends mid-header', () => {
    expect(() => stripImageMetadata(pngWithChunkPastEnd(), 'image/png')).toThrow(/runs past the end of the file/)
    expect(() => stripImageMetadata(Uint8Array.from([...PNG_SIGNATURE, 0x00, 0x00, 0x00, 0x04, 0x49]), 'image/png')).toThrow(
      /ends inside the chunk header/,
    )
  })

  it('refuses a PNG with an eXIf chunk welded on after IEND, where the walk cannot reach it', () => {
    // The PNG version of a crafted trailer: a reader that scans the whole file for chunk
    // types would find this one, so publishing it would publish the coordinates too.
    expect(() => stripImageMetadata(pngWithChunkAfterIend(), 'image/png')).toThrow(/follow the IEND chunk/)
  })

  it('refuses a PNG with no IEND at all', () => {
    const truncated = pngWith(pngChunk('IHDR', pngIhdr()), pngChunk('IDAT', pngIdat()))
    expect(() => stripImageMetadata(truncated, 'image/png')).toThrow(/before an IEND chunk/)
  })

  it('refuses a file whose PNG signature is not the eight bytes it should be', () => {
    expect(() => stripImageMetadata(Uint8Array.from(cleanPng()).subarray(1), 'image/png')).toThrow(/eight-byte PNG signature/)
  })
})

describe('WebP: RIFF chunks', () => {
  it('removes the EXIF chunk, rewrites the RIFF size, and clears the declaration bit that just became false', () => {
    const file = webpWithGpsExif()
    const result = stripImageMetadata(file, 'image/webp')

    expect(result.containers).toEqual(['EXIF chunk'])
    expect(containsSequence(result.bytes, GPS)).toBe(false)
    expect(readU32LE(result.bytes, 4)).toBe(result.bytes.length - 8) // the container's own length
    // VP8X declares its metadata; the flags payload is identical apart from the EXIF bit
    // we just invalidated, which is the only content byte this format's stripper touches.
    const before = webpChunkPayload(file, 'VP8X')
    const after = webpChunkPayload(result.bytes, 'VP8X')
    expect(before[0]).toBe(0x08)
    expect(after[0]).toBe(0x00)
    expect(after.subarray(1)).toEqual(before.subarray(1))
    expect(webpChunkPayload(result.bytes, 'VP8 ')).toEqual(webpChunkPayload(file, 'VP8 ')) // the picture
    expect(stripImageMetadata(result.bytes, 'image/webp').removedBytes).toBe(0)
  })

  it('removes EXIF and XMP together, clears both bits, and leaves the colour profile chunk alone', () => {
    const file = webpWithExifAndXmp()
    const result = stripImageMetadata(file, 'image/webp')

    expect(result.containers).toEqual(['EXIF chunk', 'XMP  chunk'])
    expect(containsSequence(result.bytes, GPS)).toBe(false)
    expect(containsSequence(result.bytes, asciiBytes('GPSLatitude'))).toBe(false)
    expect(webpChunkPayload(result.bytes, 'ICCP')).toEqual(webpChunkPayload(file, 'ICCP'))
    expect(webpChunkPayload(result.bytes, 'VP8X')[0]).toBe(0x00)
    expect(readU32LE(result.bytes, 4)).toBe(result.bytes.length - 8)
  })

  it('keeps a WebP that has optional chunks but no metadata', () => {
    const file = cleanWebp()
    const result = stripImageMetadata(file, 'image/webp')

    expect(result.bytes).toBe(file)
    expect(result.removedBytes).toBe(0)
  })

  it('refuses a RIFF whose declared size disagrees with the file', () => {
    const lying = Uint8Array.from(cleanWebp())
    lying[4] = lying[4] + 5
    expect(() => stripImageMetadata(lying, 'image/webp')).toThrow(/declares \d+ bytes after itself/)
  })

  it('refuses an odd-sized chunk whose padding byte is missing', () => {
    const iccp = riffChunk('ICCP', Uint8Array.from([0x01, 0x02, 0x03]))
    const unpadded = Uint8Array.from(iccp.subarray(0, iccp.length - 1))
    const file = buildWebp(vp8xChunk(0x20), webpImageChunkOf(cleanWebp()), unpadded)
    expect(() => stripImageMetadata(file, 'image/webp')).toThrow(/padding byte/)
  })

  it('refuses a container with no image chunk, and one that is not a WEBP form', () => {
    expect(() => stripImageMetadata(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, ...asciiBytes('WEBP')]), 'image/webp')).toThrow(
      /no VP8, VP8L or VP8X/,
    )
    expect(() => stripImageMetadata(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, ...asciiBytes('AVI ')]), 'image/webp')).toThrow(
      /not a RIFF container/,
    )
  })
})

describe('GIF: declined, with the reason asserted rather than claimed', () => {
  it('returns an ordinary GIF unchanged', () => {
    const file = cleanGif()
    const result = stripImageMetadata(file, 'image/gif')

    expect(result.bytes).toBe(file)
    expect(result.removedBytes).toBe(0)
    expect(result.format).toBe('GIF')
  })

  it('refuses a GIF carrying an XMP or EXIF application extension instead of rewriting GIF blocks', () => {
    expect(() => stripImageMetadata(gifWithXmpApplication(), 'image/gif')).toThrow(/XMP or EXIF application extension/)
    expect(() => stripImageMetadata(gifWithExifApplication(), 'image/gif')).toThrow(/XMP or EXIF application extension/)
  })

  it('refuses a file that does not start with a GIF magic, so the gate cannot be talked past', () => {
    const lying = Uint8Array.from(cleanGif())
    lying[5] = 0x62 // "GIF89b"
    expect(() => stripImageMetadata(lying, 'image/gif')).toThrow(/does not begin with GIF87a or GIF89a/)
  })
})

describe('dispatch', () => {
  it('has a stripper for each of the four types the upload sniff can return, and an empty file is refused by all of them', () => {
    for (const contentType of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
      expect(() => stripImageMetadata(new Uint8Array(0), contentType)).toThrow(ImageParseError)
    }
  })

  it('refuses a content type nothing measured, rather than returning the bytes as if they had been inspected', () => {
    // A caller that skipped the sniff would otherwise get `bytes === source` back and
    // could publish it believing the metadata question had been answered.
    expect(() => stripImageMetadata(cleanJpeg(), 'image/svg+xml')).toThrow(/no metadata stripper/)
  })

  it('names the format in the error, so the upload path can log which parser stopped', () => {
    try {
      stripImageMetadata(pngWithBadCrc(), 'image/png')
      expect.unreachable()
    } catch (error) {
      expect((error as ImageParseError).format).toBe('PNG')
      expect((error as ImageParseError).name).toBe('ImageParseError')
    }
  })
})

// ── readers used by more than one assertion above ────────────────────────────

/** The whole chunk — length field, type, payload, CRC — so a one-byte shift cannot pass. */
function pngChunkOf(png: Uint8Array, type: string): Uint8Array {
  const at = pngChunkStart(png, type)
  return png.subarray(at, at + 12 + readU32BE(png, at))
}

/** Just a chunk's data, for the assertions that need to decompress what it holds. */
function pngChunkPayload(png: Uint8Array, type: string): Uint8Array {
  const at = pngChunkStart(png, type)
  return png.subarray(at + 8, at + 8 + readU32BE(png, at))
}

function pngChunkStart(png: Uint8Array, type: string): number {
  let cursor = 8
  while (cursor + 12 <= png.length) {
    const size = readU32BE(png, cursor)
    const name = asciiAt(png, cursor + 4, 4)
    if (name === type) return cursor
    cursor += 12 + size
  }
  throw new Error(`fixture has no ${type} chunk`)
}

function webpChunkPayload(riff: Uint8Array, type: string): Uint8Array {
  let cursor = 12
  while (cursor + 8 <= riff.length) {
    const name = asciiAt(riff, cursor, 4)
    const size = readU32LE(riff, cursor + 4)
    if (name === type) return riff.subarray(cursor + 8, cursor + 8 + size)
    cursor += 8 + size + (size % 2)
  }
  throw new Error(`fixture has no ${type} chunk`)
}

/** The image chunk of a WebP file, for reassembling malformed fixtures. */
function webpImageChunkOf(riff: Uint8Array): Uint8Array {
  let cursor = 12
  while (cursor + 8 <= riff.length) {
    const name = asciiAt(riff, cursor, 4)
    const size = readU32LE(riff, cursor + 4)
    const end = cursor + 8 + size + (size % 2)
    if (name === 'VP8 ' || name === 'VP8L') return riff.subarray(cursor, end)
    cursor = end
  }
  throw new Error('fixture has no image chunk')
}

function asciiAt(bytes: Uint8Array, from: number, length: number): string {
  return new TextDecoder().decode(bytes.subarray(from, from + length))
}

function readU32BE(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
}

function readU32LE(bytes: Uint8Array, at: number): number {
  return ((bytes[at + 3] << 24) | (bytes[at + 2] << 16) | (bytes[at + 1] << 8) | bytes[at]) >>> 0
}
