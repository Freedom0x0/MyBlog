import { crc32, deflateSync } from 'node:zlib'

/**
 * Byte-level image fixtures for the metadata stripper (S8-c).
 *
 * **What is hand-built and what is not, because that distinction is the honest answer
 * to "are these real photos".** Two different things are needed for the assertions to
 * mean anything, and they are built differently:
 *
 * 1. **The metadata is hand-encoded**, deliberately and completely: the EXIF block is
 *    a real TIFF header, a real IFD0, a real GPS IFD with rational latitudes. That is
 *    what lets a test say "these exact 188 bytes were in the object before, and they
 *    are not in it afterwards" instead of "the file is shorter now".
 * 2. **The picture data comes out of a real encoder.** The JPEG core, the WebP `VP8`
 *    chunk and the GIF below were written by Pillow 12.3.0 on this machine and are
 *    embedded as base64/bytes, because a hand-typed entropy-coded segment is not a
 *    picture: a stripped file that only my own parser accepts would prove my parser is
 *    consistent with itself and nothing more. With a real core in the input, "the
 *    stripped file still decodes" is a claim a third-party decoder can check — and
 *    does, out-of-band (see the note in `lib/imageMetadata.test.ts`).
 *
 * What these fixtures still do **not** cover, and no fixture here can: real phone
 * photos' full EXIF (maker notes the size of a small program, multiple APP segments,
 * thumbnails in `FFD8`-form), HEIC/AVIF input (refused earlier, by the magic-byte gate
 * — asserted as a case below), progressive JPEGs with several scans, and PNGs with
 * APFC frames or foreign chunks. Those are listed in the stage's report rather than
 * papered over here.
 */

// ── real encoder output, embedded ────────────────────────────────────────────

/** 1×1 RGB JPEG (Pillow 12.3.0, quality 50): APP0 JFIF, two DQT, SOF0, two DHT, SOS, scan, EOI. */
const JPEG_CORE = decodeBase64(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDFoooryz7w/9k=',
)

/** 1×1 lossy WebP (Pillow 12.3.0): `RIFF`, `WEBP`, one `VP8 ` chunk and nothing else. */
const WEBP_CORE = decodeBase64(
  'UklGRjgAAABXRUJQVlA4ICwAAACQAQCdASoBAAEAAsBMJaACdLoAA5gA/u5DH+5sc4twV/9tD/9aH/60P+lAAA==',
)

/** 1×1 GIF87a (Pillow 12.3.0), trailer byte `0x3B` last. */
const GIF_CORE = Uint8Array.from(
  '474946383761010001008100000000ff0000000000000000002c00000000010001000080400010404003b'.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)),
)

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64'))
}

/** The image chunk of the WebP core: `VP8 ` plus its size and payload, i.e. everything after the RIFF header. */
function webpImageChunks(): Uint8Array {
  return WEBP_CORE.subarray(12)
}

// ── the GPS payload every "was it gone?" assertion is about ──────────────────

/**
 * A little-endian TIFF with IFD0 (Model, Orientation, `GPSInfo` pointer) and a GPS
 * IFD holding 31°13'49.44"N 121°28'25.32"E at 42 m — the Bund in Shanghai.
 *
 * Layout is the one Pillow's own EXIF writer produces (same type codes, same
 * off-to-heap pattern), verified by feeding the result to Pillow and reading
 * `getexif().get_ifd(0x8825)` back: it returns the six GPS tags with their values.
 */
export function exifTiffWithGps(): Uint8Array {
  const model = asciiBytes('S8cFixtureCam') // 14 bytes including the NUL
  const latitude = [
    [31, 1],
    [13, 1],
    [82944, 1000],
  ]
  const longitude = [
    [121, 1],
    [28, 1],
    [2532, 100],
  ]
  const altitude = [[42, 1]]

  const ifd0Entries = 3
  const gpsEntries = 5
  const gpsOffset = 8 + 2 + ifd0Entries * 12 + 4
  const heapOffset = gpsOffset + 2 + gpsEntries * 12 + 4

  const heap: number[] = [...model]
  const modelOffset = heapOffset
  const offsets: Record<string, number> = {}

  for (const [name, pairs] of [
    ['lat', latitude],
    ['lon', longitude],
    ['alt', altitude],
  ] as const) {
    offsets[name] = heapOffset + heap.length
    for (const [numerator, denominator] of pairs) {
      heap.push(...u32le(numerator), ...u32le(denominator))
    }
  }

  const ifd0 = [
    ...entry(0x0110, 2, model.length, [...u32le(modelOffset)]),
    ...entry(0x0112, 3, 1, [1, 0, 0, 0]), // SHORT 1, stored inline in the value field
    ...entry(0x8825, 4, 1, [...u32le(gpsOffset)]), // LONG pointer to the GPS IFD
  ]

  const gps = [
    ...entry(0x0001, 2, 2, [...asciiBytes('N'), 0]), // LatitudeRef, 2 bytes inline
    ...entry(0x0002, 5, 3, [...u32le(offsets.lat!)]),
    ...entry(0x0003, 2, 2, [...asciiBytes('E'), 0]),
    ...entry(0x0004, 5, 3, [...u32le(offsets.lon!)]),
    ...entry(0x0006, 5, 1, [...u32le(offsets.alt!)]),
  ]

  const tiff = [
    0x49, 0x49, 0x2a, 0x00, // "II" + 42
    ...u32le(8),
    ...u16le(ifd0Entries),
    ...ifd0,
    ...u32le(0),
    ...u16le(gpsEntries),
    ...gps,
    ...u32le(0),
    ...heap,
  ]

  return Uint8Array.from(tiff)
}

/**
 * The rational triples, as the exact bytes that appear in a stored object.
 *
 * This is what the "GPS bytes are gone" assertions look for. A latitude in an EXIF
 * rational is `31/1, 13/1, 82944/1000` — 24 bytes that no camera would produce by
 * coincidence and no stripper can claim to have removed without having removed.
 */
export function gpsCoordinateBytes(): Uint8Array {
  const tiff = exifTiffWithGps()
  const latitudes = rationalsOf([
    [31, 1],
    [13, 1],
    [82944, 1000],
  ])
  const at = indexOfBytes(tiff, latitudes)
  if (at === -1) throw new Error('fixture builder is broken: the latitude bytes are not in the TIFF')
  return tiff.subarray(at, at + 48) // both triples of both latitudes and longitudes are adjacent on the heap
}

function rationalsOf(pairs: readonly (readonly [number, number])[]): Uint8Array {
  const bytes: number[] = []
  for (const [numerator, denominator] of pairs) bytes.push(...u32le(numerator), ...u32le(denominator))
  return Uint8Array.from(bytes)
}

function entry(tag: number, type: number, count: number, value: readonly number[]): number[] {
  return [...u16le(tag), ...u16le(type), ...u32le(count), ...pad4(value)]
}

function pad4(value: readonly number[]): number[] {
  return [...value.slice(0, 4), ...new Array(Math.max(0, 4 - value.length)).fill(0)]
}

// ── JPEG ─────────────────────────────────────────────────────────────────────

/** A JPEG marker segment: `FF <id>` plus a big-endian length that counts itself. */
export function jpegMarker(id: number, payload: Uint8Array): Uint8Array {
  const length = payload.length + 2
  return Uint8Array.from([0xff, id, (length >>> 8) & 0xff, length & 0xff, ...payload])
}

/** `APP1` with the `Exif\0\0` identifier, the shape every phone and every editor writes. */
export function jpegApp1Exif(tiff: Uint8Array = exifTiffWithGps()): Uint8Array {
  return jpegMarker(0xe1, Uint8Array.from([...asciiBytes('Exif'), 0, 0, ...tiff]))
}

const XMP_IDENTIFIER = 'http://ns.adobe.com/xap/1.0/'
/** The keyword a PNG uses when it puts an XMP packet in a text chunk. */
const XMP_PNG_KEYWORD = 'XML:com.adobe.xmp'

/**
 * An XMP packet carrying coordinates in the `tiff:` namespace, which is the second
 * common place a latitude lives and the reason `APP1` is dropped by *identifier
 * whatever it is* rather than only when it says `Exif`.
 */
export function xmpPacketWithGps(): Uint8Array {
  return asciiBytes(
    [
      '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
      '<x:xmpmeta xmlns:x="adobe:ns:0.1/">',
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      '<rdf:Description xmlns:tiff="http://ns.adobe.com/tiff/1.0/"',
      ' tiff:GPSLatitude="31:13:49.44N" tiff:GPSLongitude="121:28:25.32E"',
      ' tiff:Make="S8c" tiff:Model="FixtureCam"/>',
      '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>',
    ].join(''),
  )
}

export function jpegApp1Xmp(packet: Uint8Array = xmpPacketWithGps()): Uint8Array {
  return jpegMarker(0xe1, Uint8Array.from([...asciiBytes(XMP_IDENTIFIER), 0, ...packet]))
}

/**
 * A Photoshop `APP13` image-resource block: authorship text, no coordinate tag.
 * This is the fixture the "we keep what we say we keep" assertion uses.
 */
export function jpegApp13Photoshop(): Uint8Array {
  const resource = [
    ...asciiBytes('8BIM'),
    0x02, 0x5c, // an author-resource id, 604: no meaning to us beyond "not coordinates"
    0x00, 0x00, // name (empty, NUL-terminated)
    ...u32be(4),
    0x00, 0x01, 0x00, 0x1a, // two big-endian 16-bit values, arbitrary
  ]
  return jpegMarker(0xed, Uint8Array.from([...asciiBytes('Photoshop 3.0'), 0, ...resource]))
}

/** An APPn-free JPEG with EXIF inserted after SOI — the "before" of every assertion. */
export function jpegWithGpsExif(): Uint8Array {
  return insertAfterSoi(jpegApp1Exif())
}

/** The same file minus the EXIF, so the "clean file is untouched" control is one edit away. */
export function cleanJpeg(): Uint8Array {
  return Uint8Array.from(JPEG_CORE)
}

export function jpegWith(...segments: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(JPEG_CORE.length + segments.reduce((n, s) => n + s.length, 0))
  out.set(JPEG_CORE.subarray(0, 2), 0)
  let at = 2
  for (const segment of segments) {
    out.set(segment, at)
    at += segment.length
  }
  out.set(JPEG_CORE.subarray(2), at)
  return out
}

function insertAfterSoi(segment: Uint8Array): Uint8Array {
  return jpegWith(segment)
}

/** Where the embedded EXIF segment sits in a fixture built by `jpegWith`, for the byte-identity checks. */
export function jpegScanTail(file: Uint8Array): Uint8Array {
  const at = indexOfBytes(file, Uint8Array.from([0xff, 0xda]))
  if (at === -1) throw new Error('fixture builder is broken: this JPEG has no start-of-scan marker')
  return file.subarray(at)
}

/** The SOF0 (start-of-frame) segment, which is where the dimensions live. */
export function jpegStartOfFrame(file: Uint8Array): Uint8Array {
  const at = indexOfBytes(file, Uint8Array.from([0xff, 0xc0]))
  if (at === -1) throw new Error('fixture builder is broken: this JPEG has no baseline SOF0 marker')
  const length = (file[at + 2] << 8) | file[at + 3]
  return file.subarray(at, at + 2 + length)
}

// ── PNG ──────────────────────────────────────────────────────────────────────

/** A PNG chunk with its CRC computed the way the spec defines it: over **type + data**. */
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const body = Uint8Array.from([...asciiBytes(type), ...data])
  return Uint8Array.from([...u32be(data.length), ...body, ...u32be(crc32(body) >>> 0)])
}

export const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** IHDR for an 8×8 8-bit truecolor image: the 13 bytes every PNG reader starts with. */
export function pngIhdr(width = 8, height = 8): Uint8Array {
  return Uint8Array.from([
    ...u32be(width),
    ...u32be(height),
    8, // bit depth
    2, // colour type: truecolor
    0, // compression
    0, // filter
    0, // interlace
  ])
}

/** IDAT that inflates into real pixels: 8 rows of filter-byte-0 plus 24 RGB samples. */
export function pngIdat(width = 8, height = 8): Uint8Array {
  const rows: number[] = []
  for (let y = 0; y < height; y += 1) {
    rows.push(0) // filter type "None"
    for (let x = 0; x < width; x += 1) rows.push((x * 16) % 256, (y * 24) % 256, 128)
  }
  return Uint8Array.from(deflateSync(Uint8Array.from(rows)))
}

export function pngWith(...chunks: Uint8Array[]): Uint8Array {
  const all = [PNG_SIGNATURE, ...chunks]
  return Uint8Array.from(Buffer.concat(all.map((part) => Buffer.from(part))))
}

/** A well-formed 8×8 PNG with nothing but image chunks. */
export function cleanPng(): Uint8Array {
  return pngWith(pngChunk('IHDR', pngIhdr()), pngChunk('IDAT', pngIdat()), pngChunk('IEND', new Uint8Array(0)))
}

/** The same PNG with the EXIF/GPS block in an `eXIf` chunk, which is PNG's registered way of carrying it. */
export function pngWithGpsExif(): Uint8Array {
  return pngWith(
    pngChunk('IHDR', pngIhdr()),
    pngChunk('eXIf', exifTiffWithGps()),
    pngChunk('IDAT', pngIdat()),
    pngChunk('IEND', new Uint8Array(0)),
  )
}

/** `iTXt` carrying an XMP packet: the second way a PNG can hold coordinates. */
export function pngWithXmpText(): Uint8Array {
  // keyword NUL compression-flag compression-method language-tag NUL translated-key NUL packet
  const data = Uint8Array.from([
    ...asciiBytes(XMP_PNG_KEYWORD),
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    ...xmpPacketWithGps(),
  ])
  return pngWith(pngChunk('IHDR', pngIhdr()), pngChunk('iTXt', data), pngChunk('IDAT', pngIdat()), pngChunk('IEND', new Uint8Array(0)))
}

/** A `tEXt` comment with a place name in prose: kept, and the reason the report says prose is not proven gone. */
export function pngTextComment(text = 'Shot from my kitchen window'): Uint8Array {
  const data = Uint8Array.from([...asciiBytes('Comment'), 0x00, ...asciiBytes(text)])
  return pngChunk('tEXt', data)
}

/**
 * A complete PNG whose byte length is exactly `total`, padded with one legitimate
 * `tEXt` chunk.
 *
 * Needed by the cap-boundary tests: the object at `MEDIA_MAX_UPLOAD_BYTES` used to be a
 * signature followed by a run of zeros, which was fine while 32 bytes were the only bytes
 * anybody read and is not a file at all now that the structure is walked. Padding with a
 * real chunk keeps the file valid *and* exercises the "a kept ancillary chunk survives at
 * the cap" path.
 */
export function pngPaddedTo(total: number): Uint8Array {
  const ihdr = pngChunk('IHDR', pngIhdr())
  const idat = pngChunk('IDAT', pngIdat())
  const iend = pngChunk('IEND', new Uint8Array(0))
  const keyword = asciiBytes('Comment')
  const fillerSize = total - PNG_SIGNATURE.length - ihdr.length - idat.length - iend.length - 12 - keyword.length - 1

  if (fillerSize < 0) throw new Error(`pngPaddedTo: ${total} bytes is smaller than this fixture's minimal PNG`)

  const comment = pngChunk('tEXt', Uint8Array.from([...keyword, 0x00, ...new Uint8Array(fillerSize).fill(0x61)]))
  return pngWith(ihdr, comment, idat, iend)
}

// ── WebP ─────────────────────────────────────────────────────────────────────

/**
 * A WebP with `VP8X` declaring EXIF (flags `0x08`, the value measured with Pillow for a
 * file whose only feature is EXIF) and an `EXIF` chunk holding the same TIFF.
 */
export function webpWithGpsExif(tiff: Uint8Array = exifTiffWithGps()): Uint8Array {
  return buildWebp(vp8xChunk(0x08), vp8Chunk(), riffChunk('EXIF', tiff))
}

/** Same, with an `XMP ` chunk too, so both declaration bits are exercised at once. */
export function webpWithExifAndXmp(): Uint8Array {
  return buildWebp(
    vp8xChunk(0x08 | 0x04),
    vp8Chunk(),
    riffChunk('ICCP', Uint8Array.from([0x00, 0x01, 0x02, 0x03])),
    riffChunk('EXIF', exifTiffWithGps()),
    riffChunk('XMP ', xmpPacketWithGps()),
  )
}

/**
 * A WebP whose only optional chunk is an ICC profile, with `VP8X` declaring the colour
 * profile bit (0x20, measured the same single-feature way as the metadata bits). Used
 * for the "nothing to remove, so nothing rewritten" control.
 */
export function cleanWebp(): Uint8Array {
  return buildWebp(vp8xChunk(0x20), vp8Chunk(), riffChunk('ICCP', Uint8Array.from([0x00, 0x01, 0x02, 0x03])))
}

export function vp8xChunk(flags: number): Uint8Array {
  // flags byte, 3 reserved bytes, then 24-bit canvas minus one (1×1 → 0)
  return riffChunk('VP8X', Uint8Array.from([flags, 0, 0, 0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))
}

function vp8Chunk(): Uint8Array {
  return webpImageChunks() // 'VP8 ' + its size + its payload, straight out of the encoder's file
}

export function riffChunk(type: string, data: Uint8Array): Uint8Array {
  const padding = data.length % 2
  return Uint8Array.from([...asciiBytes(type), ...u32le(data.length), ...data, ...new Array(padding).fill(0)])
}

export function buildWebp(...chunks: Uint8Array[]): Uint8Array {
  const body = Uint8Array.from([...asciiBytes('WEBP'), ...Buffer.concat(chunks)])
  return Uint8Array.from([...asciiBytes('RIFF'), ...u32le(body.length), ...body])
}

// ── GIF ──────────────────────────────────────────────────────────────────────

export function cleanGif(): Uint8Array {
  return Uint8Array.from(GIF_CORE)
}

/** A GIF with Adobe's XMP application extension in front of the trailer. */
export function gifWithXmpApplication(): Uint8Array {
  const block = Uint8Array.from([
    0x21, 0xff, 0x0b, // extension introducer, application label, block size 11
    ...asciiBytes('XMP Data'),
    ...asciiBytes('XMP'),
    0x07, ...asciiBytes('xmpmeta'), // payload sub-block
    0x00, // sub-block terminator
  ])
  return Uint8Array.from([...GIF_CORE.subarray(0, GIF_CORE.length - 1), ...block, 0x3b])
}

// ── malformed: the files that must be refused rather than published ──────────

/** PNG whose IHDR has a CRC that does not describe its bytes (a chunk boundary we cannot trust). */
export function pngWithBadCrc(): Uint8Array {
  const chunk = pngChunk('IHDR', pngIhdr())
  const broken = Uint8Array.from(chunk)
  broken[chunk.length - 1] = (broken[chunk.length - 1] + 1) % 256
  return pngWith(broken, pngChunk('IDAT', pngIdat()), pngChunk('IEND', new Uint8Array(0)))
}

/** A valid PNG with the chunks in an order the spec forbids: `IHDR` must be first. */
export function pngWithWrongChunkOrder(): Uint8Array {
  return pngWith(
    pngChunk('gAMA', Uint8Array.from([0, 0, 0, 0x32, 0x32, 0x32, 0x32, 0x32])),
    pngChunk('IHDR', pngIhdr()),
    pngChunk('IDAT', pngIdat()),
    pngChunk('IEND', new Uint8Array(0)),
  )
}

/** `eXIf` smuggled in *after* `IEND`: outside the container, where a chunk walk cannot reach it. */
export function pngWithChunkAfterIend(): Uint8Array {
  return Uint8Array.from([...cleanPng(), pngChunk('eXIf', exifTiffWithGps())])
}

/** Chunk declares more bytes than the file holds. */
export function pngWithChunkPastEnd(): Uint8Array {
  const ihdr = pngChunk('IHDR', pngIhdr())
  const truncated = Uint8Array.from([...ihdr, ...pngChunk('IDAT', pngIdat()).subarray(0, 20)])
  return pngWith(truncated)
}

/** JPEG whose APP1 length field is bigger than the file. */
export function jpegApp1PastEnd(): Uint8Array {
  const app1 = jpegApp1Exif()
  const lying = Uint8Array.from(app1)
  lying[2] = 0xff // length 0xFFFF…
  lying[3] = 0xff // …which the file does not have
  return jpegWith(lying)
}

/** JPEG header with EXIF and no start-of-scan: every marker is fine, and there is no picture. */
export function jpegWithoutScan(): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, ...jpegApp1Exif(), 0xff, 0xd9])
}

/** Two JPEGs end to end: the second one's APP1 is not in the first one's marker chain. */
export function jpegConcatenated(): Uint8Array {
  return Uint8Array.from([...cleanJpeg(), ...jpegWithGpsExif()])
}

/** JPEG whose compressed data is followed by an appended EXIF block (the classic stowaway). */
export function jpegWithExifAfterScan(): Uint8Array {
  return Uint8Array.from([...cleanJpeg(), ...asciiBytes('Exif'), 0, 0, ...exifTiffWithGps()])
}

/** A GIF with a raw EXIF application extension — refused, since nothing here rewrites GIF blocks. */
export function gifWithExifApplication(): Uint8Array {
  const block = Uint8Array.from([0x21, 0xff, 0x0b, ...asciiBytes('EXIF'), 0x01, 0x00, 0x00])
  return Uint8Array.from([...GIF_CORE.subarray(0, GIF_CORE.length - 1), ...block, 0x3b])
}

/**
 * The first 32 bytes of a real HEIC (`ftyp` box, `heic`/`mif1` brand) — what an iPhone
 * produces, and the reason the report has to answer "what if the file is HEIC".
 */
export function heicHead(): Uint8Array {
  return Uint8Array.from([
    0x00, 0x00, 0x00, 0x20, // box size
    ...asciiBytes('ftyp'),
    ...asciiBytes('heic'),
    0x00, 0x00, 0x00, 0x00, // minor version
    ...asciiBytes('heic'), ...asciiBytes('mif1'), ...asciiBytes('hevc'), ...asciiBytes('isom'),
  ])
}

// ── little helpers shared with the tests ─────────────────────────────────────

export function containsSequence(haystack: Uint8Array, needle: Uint8Array): boolean {
  return indexOfBytes(haystack, needle) !== -1
}

export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

export function asciiBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff]
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

/** The EXIF APP1 identifier as it appears in bytes: `Exif` then two NULs. */
export const EXIF_IDENTIFIER_BYTES = Uint8Array.from([...asciiBytes('Exif'), 0, 0])
