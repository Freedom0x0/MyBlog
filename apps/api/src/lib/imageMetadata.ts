import { crc32 } from 'node:zlib'

/**
 * Lossless metadata stripper for the four image types stage F accepts.
 *
 * **What this is not: a re-encoder.** Nothing here decodes pixels, resamples them, or
 * writes a new JPEG/PNG. A re-encode would (a) need a native image dependency, (b)
 * quietly cost every uploaded photo a generation of quality, and (c) make "did the
 * picture change?" unanswerable. What this does is *byte surgery on the container*:
 * locate the segments whose defined purpose is to carry metadata, cut them out, copy
 * every other byte through untouched. The image data comes back identical — which is
 * exactly what the tests in `lib/imageMetadata.test.ts` assert, rather than asserting
 * "looks fine".
 *
 * **Why the containers named below are the ones that matter.** A phone photo's
 * coordinates live in EXIF's GPS IFD (`APP1`/`Exif\0\0` in JPEG, `eXIf` in PNG, `EXIF`
 * in WebP), and an increasing share of cameras and editing tools copy those same
 * numbers into XMP (`APP1`/`http://ns.adobe.com/xap/1.0/` in JPEG, `iTXt` with the
 * keyword `XML:com.adobe.xmp` in PNG, `XMP ` in WebP). Both go. Everything else an
 * image can carry — JFIF thumbnail, colour profile, quantisation tables, the scan
 * data — stays.
 *
 * **The rule that governs every judgement call in this file**: when the structure is
 * not understandable, *throw*. A parser that returns the input unchanged when it
 * cannot finish its walk has quietly become a no-op, and the caller cannot tell that
 * apart from "clean image". The upload path turns `ImageParseError` into a refusal, so
 * "we cannot prove this has no coordinates" never becomes "publish it anyway".
 *
 * Documented per-format decisions, including the ones that decline to do work, are at
 * each function below.
 */

/** The formats this file knows how to take apart, keyed on the MIME type the sniff measured. */
export type ImageMetadataFormat = 'JPEG' | 'PNG' | 'WebP' | 'GIF'

/** Which stripper runs for which measured type. The keys are exactly what `sniffImageType` can return. */
const FORMAT_BY_CONTENT_TYPE: Record<string, ImageMetadataFormat> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'image/gif': 'GIF',
}

/**
 * Thrown when a file's structure cannot be walked to its end.
 *
 * Deliberately not an `ApiError`: this module has no opinion about HTTP status codes
 * or the shared error vocabulary, and keeping it out of the signature means the
 * stripper is testable without `shared` or a request in sight. `uploads/service.ts`
 * owns the translation into 415.
 *
 * `reason` is safe to put in a client-facing message: every string below describes the
 * *file's* structure and the byte offset at which it stopped making sense. None of
 * them can contain a bucket name, a path, or a credential, because none of them are
 * assembled from anything but this module's own constants.
 */
export class ImageParseError extends Error {
  constructor(
    readonly format: string,
    readonly reason: string,
  ) {
    super(`${format} image could not be parsed: ${reason}`)
    this.name = 'ImageParseError'
  }
}

export interface StrippedImage {
  /**
   * The bytes that should be stored.
   *
   * When nothing was removed this is the *same array* the caller passed in — so the
   * "a clean file comes back byte-identical" claim is true by construction, and the
   * test that asserts it is guarding against a future change of heart rather than a
   * present bug.
   */
  bytes: Uint8Array
  /** `source.length - bytes.length`: how much metadata left the file, 0 when nothing did. */
  removedBytes: number
  /**
   * Names of the containers that were dropped, e.g. `['APP1/Exif', 'APP1/XMP']`.
   * For the operator's log line and for tests; never part of an API response, because
   * a response field naming which metadata a photo carried is its own small leak.
   */
  containers: readonly string[]
  format: ImageMetadataFormat
}

// ── signatures ───────────────────────────────────────────────────────────────

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const GIF_MAGICS = ['GIF87a', 'GIF89a']

/** The six bytes JPEG and HEIF-style containers use to introduce an EXIF payload. */
const EXIF_IDENTIFIER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00] // "Exif\0\0"
const XMP_NAMESPACE = 'http://ns.adobe.com/xap'
/** The keyword a PNG uses when it puts an XMP packet in a text chunk. */
const PNG_XMP_KEYWORD = 'XML:com.adobe.xmp'

/**
 * GIF application-extension openers: `!` `0xFF` `0x0B` then an 8-byte application
 * identifier. `XMP Data` + `XMP` is the form Adobe's tools write; `EXIF` is what the
 * handful of experiments in this space used. Both are *detected*, never stripped —
 * see `stripGif` for why.
 */
const GIF_XMP_APPLICATION = [0x21, 0xff, 0x0b, 0x58, 0x4d, 0x50, 0x20, 0x44, 0x61, 0x74, 0x61, 0x58, 0x4d, 0x50]
const GIF_EXIF_APPLICATION = [0x21, 0xff, 0x0b, 0x45, 0x58, 0x49, 0x46]

/**
 * The two declaration bits of a WebP `VP8X` chunk that say "this file has metadata".
 *
 * Not read off a specification document — measured on this machine with Pillow 12.3.0
 * by saving the same 4×4 image twice, once with only EXIF and once with only XMP, and
 * reading the flags byte back: EXIF-only gives `0x08`, XMP-only gives `0x04`, and an
 * ICC-profile-only file gives `0x20`. Single-feature files make the mapping
 * unambiguous, which is the reason for doing it that way round rather than trusting a
 * remembered bit diagram: clearing the wrong bit here would silently tell a decoder
 * "no alpha" or "no animation" and corrupt the *picture*.
 */
const VP8X_FLAG_EXIF = 0x08
const VP8X_FLAG_XMP = 0x04
/** Where the flags byte sits inside a `VP8X` chunk's payload. */
const VP8X_FLAGS_OFFSET = 8 // chunk type(4) + size(4)

// ── byte helpers ─────────────────────────────────────────────────────────────

function startsWith(source: Uint8Array, bytes: readonly number[], offset = 0): boolean {
  if (source.length < offset + bytes.length) return false
  return bytes.every((byte, index) => source[offset + index] === byte)
}

function readU16BE(source: Uint8Array, at: number): number {
  return (source[at] << 8) | source[at + 1]
}

function readU32BE(source: Uint8Array, at: number): number {
  return ((source[at] << 24) | (source[at + 1] << 16) | (source[at + 2] << 8) | source[at + 3]) >>> 0
}

function readU32LE(source: Uint8Array, at: number): number {
  return ((source[at + 3] << 24) | (source[at + 2] << 16) | (source[at + 1] << 8) | source[at]) >>> 0
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('latin1')

function asciiBytes(value: string): Uint8Array {
  return encoder.encode(value)
}

/** `value` decoded as latin-1, i.e. one byte per character, no normalization. */
function ascii(source: Uint8Array, from: number, length: number): string {
  return decoder.decode(source.subarray(from, from + length))
}

function hex8(value: number): string {
  return value.toString(16).padStart(8, '0')
}

/** Printable name for a four-byte chunk type, so an error message can quote it safely. */
function printableType(type: string): string {
  return /^[\x20-\x7e]{4}$/.test(type) ? type : `<${[...type].map((c) => hex8(c.charCodeAt(0)).slice(-2)).join(' ')}>`
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** Naive substring search over bytes. Inputs are bounded by the upload cap, so O(n·m) is fine here. */
function indexOfSequence(source: Uint8Array, needle: readonly number[], from = 0): number {
  outer: for (let i = from; i + needle.length <= source.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (source[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

function unchanged(format: ImageMetadataFormat, source: Uint8Array): StrippedImage {
  return { format, bytes: source, removedBytes: 0, containers: [] }
}

function assemble(
  format: ImageMetadataFormat,
  source: Uint8Array,
  parts: readonly Uint8Array[],
  containers: readonly string[],
): StrippedImage {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const bytes = total === source.length && containers.length === 0 ? source : concat(parts, total)
  return { format, bytes, removedBytes: source.length - bytes.length, containers }
}

// ── entry point ──────────────────────────────────────────────────────────────

/**
 * Take the metadata out of one image, or explain why that is not possible.
 *
 * `contentType` must be the type the *bytes* were measured as (the sniff's answer),
 * never the type a client declared — a declared type is outside the presigned
 * signature and is not evidence about anything.
 */
export function stripImageMetadata(source: Uint8Array, contentType: string): StrippedImage {
  const format = FORMAT_BY_CONTENT_TYPE[contentType]

  if (format === undefined) {
    // The four keys above are the whole whitelist, so reaching this line means a
    // caller skipped the sniff. It cannot happen through a route, and the message
    // quotes nothing the client sent for that reason.
    throw new ImageParseError('image', 'the measured content type has no metadata stripper defined')
  }

  switch (format) {
    case 'JPEG':
      return stripJpeg(source)
    case 'PNG':
      return stripPng(source)
    case 'WebP':
      return stripWebp(source)
    case 'GIF':
      return stripGif(source)
  }
}

// ── JPEG ─────────────────────────────────────────────────────────────────────

/**
 * Walk the marker chain that precedes the scan data and drop every `APP1`.
 *
 * `APP1` is dropped **whenever it appears, whatever its payload identifies**, and the
 * reason is worth the paragraph: `APP1`'s identifier space is unbounded — `Exif\0\0`
 * and `http://ns.adobe.com/xap/1.0/` are the two common ones, and *both* define tags
 * for coordinates (`GPS*` in EXIF, `tiff:GPSLatitude`/`geo:lat` in XMP). Proving that a
 * given XMP packet has no location would mean parsing RDF XML and knowing every
 * namespace that can encode one (`tiff`, `exif`, `geo`, `Iptc4xmpCore`'s
 * `crdt:LocationCreated`), plus any secondary packet referenced by
 * `xmpMM:History`. A blog cover image never needs anything in `APP1`, so the rule is
 * "all of it goes" and the burden of proof is not on us.
 *
 * Kept, byte-for-byte: `APP0` (JFIF — thumbnail and density, no coordinates), `APP2`
 * (Flashpix/ICC), `APP13` (`Photoshop 3.0` image resources: authorship and caption
 * text, no coordinate tag), `COM`, `DQT`, `SOFn`, `DHT`, the `FFD8`/`FFD9` bookends,
 * and everything from the first `FFDA` (start of scan) to the end of the file.
 * `tests` assert both halves of that: metadata gone *and* the scan tail identical.
 *
 * Structured, and refused when not:
 *   - a `FFD8` prefix is required, marker ids must follow their `FF`, no `FF00`;
 *   - every length-prefixed segment's declared length has to fit in the file;
 *   - a start-of-scan marker has to exist (a header with no scan is a stub, not a
 *     picture — this is what refuses the truncated fixtures the old suite used);
 *   - the tail after `FFDA` is never parsed as markers, because entropy-coded data
 *     contains `FF`-prefixed bytes by design, and `Exif\0\0` appearing in it means
 *     somebody appended a second EXIF block after the image.
 */
function stripJpeg(source: Uint8Array): StrippedImage {
  if (source.length < 4 || source[0] !== 0xff || source[1] !== 0xd8) {
    throw new ImageParseError('JPEG', 'the file does not begin with FFD8, the start-of-image marker')
  }

  const parts: Uint8Array[] = [source.subarray(0, 2)]
  const containers: string[] = []
  let pos = 2
  let sawScan = false

  while (pos < source.length) {
    const markerStart = pos

    // T.81 allows any number of 0xFF fill bytes before a marker id.
    while (pos < source.length && source[pos] === 0xff) pos += 1
    if (pos >= source.length) {
      throw new ImageParseError('JPEG', `the file ends in fill bytes at ${markerStart} with no marker id`)
    }

    const id = source[pos]
    pos += 1

    if (id === 0x00) {
      throw new ImageParseError(
        'JPEG',
        `FF00 at ${markerStart} is byte-stuffing inside compressed data, not a marker`,
      )
    }
    if (id === 0xd8) {
      throw new ImageParseError(
        'JPEG',
        `a second start-of-image marker at ${markerStart}: two JPEGs concatenated, not one image`,
      )
    }

    if (id === 0xda) {
      // Start of scan. Everything from here is entropy-coded data plus whatever the
      // writer put after the end-of-image marker, and it is copied through as one
      // block — no marker is looked for inside it, because `FF`-prefixed bytes occur
      // legally in compressed data.
      const tail = source.subarray(markerStart)
      const smuggled = indexOfSequence(tail, EXIF_IDENTIFIER)
      if (smuggled !== -1) {
        throw new ImageParseError(
          'JPEG',
          `an "Exif" block appears ${smuggled} bytes past the start-of-scan marker, where no marker segment may live`,
        )
      }
      parts.push(tail)
      sawScan = true
      break
    }

    if (id === 0xd9) {
      throw new ImageParseError(
        'JPEG',
        'the end-of-image marker appears before any start-of-scan marker: nothing in this file decodes',
      )
    }

    if (id === 0x01 || (id >= 0xd0 && id <= 0xd7)) {
      // Standalone markers (TEM, RSTn) carry no length field and no payload.
      parts.push(source.subarray(markerStart, pos))
      continue
    }

    if (pos + 2 > source.length) {
      throw new ImageParseError('JPEG', `the marker at ${markerStart} has no length field`)
    }

    const length = readU16BE(source, pos)
    if (length < 2) {
      throw new ImageParseError(
        'JPEG',
        `the segment at ${markerStart} declares a length of ${length}, shorter than the two bytes that store it`,
      )
    }

    const segmentEnd = pos + length
    if (segmentEnd > source.length) {
      throw new ImageParseError(
        'JPEG',
        `the segment at ${markerStart} declares ${length} bytes and runs ${segmentEnd - source.length} bytes past the end of the file`,
      )
    }

    if (id === 0xe1) containers.push(`APP1/${app1Subtype(source, pos + 2, length - 2)}`)
    else parts.push(source.subarray(markerStart, segmentEnd))

    pos = segmentEnd
  }

  if (!sawScan) {
    throw new ImageParseError('JPEG', 'the marker chain ends before any start-of-scan marker')
  }

  return assemble('JPEG', source, parts, containers)
}

/** Names an `APP1` payload by its identifier, for the log line. All of them are dropped. */
function app1Subtype(source: Uint8Array, payloadStart: number, payloadLength: number): string {
  if (payloadLength >= 6 && startsWith(source, EXIF_IDENTIFIER, payloadStart)) return 'Exif'
  if (payloadLength >= XMP_NAMESPACE.length && ascii(source, payloadStart, XMP_NAMESPACE.length) === XMP_NAMESPACE) {
    return 'XMP'
  }
  return 'unidentified'
}

// ── PNG ──────────────────────────────────────────────────────────────────────

/**
 * Drop `eXIf` and any text chunk whose keyword is the XMP one; verify every chunk we
 * keep.
 *
 * **`tEXt`/`zTXt`/`iTXt`: kept, except the XMP one.** The question the brief asks is
 * whether to drop them all, since a `Comment` can say "taken at home". The answer here
 * is no, for a reason that is about the *kind* of exposure: those chunks carry prose a
 * reader would see as caption text, not a machine-readable pair of coordinates, and
 * dropping them would strip copyright and licensing statements that travel in
 * `iTXt` (`CPR`) and author attribution with no privacy gain beyond what the article's
 * own caption already says. `XML:com.adobe.xmp` is the exception precisely because it
 * is not prose: it is an RDF packet whose tags include `tiff:GPSLatitude`, so it is
 * treated as the metadata container it is and dropped with the same rule as `eXIf`.
 * What we therefore cannot prove about a PNG is stated plainly: a `tEXt` comment can
 * still contain a place name.
 *
 * **Why chunk CRCs are verified rather than ignored.** This function decides which
 * byte spans to *delete* from a file using only the four-byte length field in front of
 * each chunk. A single wrong length and the deletion eats part of `IDAT` — a corrupted
 * picture that still looks like an image to every gate upstream. The CRC is the
 * encoder's own statement that "this chunk is 8 + N + 4 bytes long and this is its
 * content", so verifying it before using the span is what makes deleting chunks safe.
 * `zlib.crc32` computes it (present since Node 22.2, verified on this machine against
 * a Pillow-written PNG's IHDR CRC) and PNG's CRC covers **chunk type + data**, not the
 * length field and not the CRC itself.
 *
 * Consequence to be honest about: a PNG written by a broken encoder — real bytes,
 * wrong CRC — used to be published and will now be refused. That is the intended
 * direction of the trade ("must not publish what we cannot prove"), and the admin sees
 * a message that says which chunk failed.
 */
function stripPng(source: Uint8Array): StrippedImage {
  if (!startsWith(source, PNG_SIGNATURE)) {
    throw new ImageParseError('PNG', 'the file does not begin with the eight-byte PNG signature')
  }

  const parts: Uint8Array[] = [source.subarray(0, 8)]
  const containers: string[] = []
  let pos = 8
  let sawIend = false

  while (pos < source.length) {
    // 12 is the shortest chunk that can exist (an empty one: 4 length + 4 type + 4 CRC),
    // so anything less than that left in the file is a header cut in half.
    if (pos + 12 > source.length) {
      throw new ImageParseError('PNG', `the file ends inside the chunk header at ${pos}`)
    }

    const size = readU32BE(source, pos)
    const type = printableType(ascii(source, pos + 4, 4))

    if (pos === 8 && type !== 'IHDR') {
      throw new ImageParseError('PNG', `the first chunk must be IHDR, this file starts with ${type}`)
    }

    const dataEnd = pos + 8 + size
    if (dataEnd + 4 > source.length) {
      throw new ImageParseError(
        'PNG',
        `the ${type} chunk at ${pos} declares ${size} bytes of data and runs past the end of the file`,
      )
    }

    const stored = readU32BE(source, dataEnd)
    const computed = crc32(source.subarray(pos + 4, dataEnd)) >>> 0
    if (stored !== computed) {
      throw new ImageParseError(
        'PNG',
        `the CRC of the ${type} chunk does not match its bytes (chunk says ${hex8(stored)}, the bytes compute ${hex8(computed)})`,
      )
    }

    const chunkEnd = dataEnd + 4
    const dropped = pngDropReason(type, source, pos + 8, size)

    if (dropped === null) parts.push(source.subarray(pos, chunkEnd))
    else containers.push(dropped)

    pos = chunkEnd
    if (type === 'IEND') {
      sawIend = true
      break
    }
  }

  if (!sawIend) throw new ImageParseError('PNG', 'the chunk list ends before an IEND chunk: the file stops mid-image')
  if (pos < source.length) {
    throw new ImageParseError(
      'PNG',
      `${source.length - pos} bytes follow the IEND chunk, and PNG has nothing that belongs there`,
    )
  }

  return assemble('PNG', source, parts, containers)
}

/** Why a PNG chunk is metadata rather than image content, or null to keep it. */
function pngDropReason(type: string, source: Uint8Array, dataStart: number, dataLength: number): string | null {
  // The registered name is `eXIf`; a file written with a different case is not a valid
  // chunk name but is exactly what an evader would try, so the comparison is by
  // uppercase and the name we report is the one in the file.
  if (type.toUpperCase() === 'EXIF') return `${type} chunk (EXIF)`

  if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
    const keyword = pngKeyword(source, dataStart, dataLength)
    if (keyword === PNG_XMP_KEYWORD) return `${type}/XMP`
  }

  return null
}

/** The keyword of a text chunk: everything up to the first NUL, which is also its spec bound. */
function pngKeyword(source: Uint8Array, dataStart: number, dataLength: number): string {
  const end = dataStart + dataLength
  for (let i = dataStart; i < end; i += 1) {
    if (source[i] === 0x00) return ascii(source, dataStart, i - dataStart)
  }
  return ''
}

// ── WebP ─────────────────────────────────────────────────────────────────────

/**
 * RIFF walk that drops `EXIF` and `XMP ` chunks and rewrites the container's own
 * length field.
 *
 * WebP's metadata containers are `EXIF` (the same TIFF/EXIF structure as a JPEG's
 * `APP1` payload, minus the marker and the `Exif\0\0` prefix) and `XMP ` (an RDF
 * packet, coordinates included). `ICCP`, `VP8 `, `VP8L`, `VP8X`, `ANIM`, `ANMF`,
 * `ALPH` and anything unknown are copied through untouched.
 *
 * Two fields are rewritten, and both are declared *lengths*, not content:
 *   1. the RIFF size at offset 4, which must equal `file length - 8` once bytes are
 *      gone. Leaving it stale is not a harmless sin — the value is what a decoder
 *      trusts when it decides how much of the buffer belongs to the file.
 *   2. the two declaration bits inside `VP8X` that say "an `EXIF` chunk exists" /
 *      "an `XMP ` chunk exists", since we just removed those chunks. The bit values
 *      are the measured ones above; nothing else in that byte is touched.
 *
 * No RIFF chunk carries a checksum, so unlike PNG there is no per-chunk integrity
 * verification available — the guard here is instead that the chunk list must tile the
 * file exactly (`RIFF` size + 8 === length is checked up front and an odd-sized chunk
 * without its padding byte is refused), which is the container saying where it ends.
 */
function stripWebp(source: Uint8Array): StrippedImage {
  if (source.length < 12 || ascii(source, 0, 4) !== 'RIFF' || ascii(source, 8, 4) !== 'WEBP') {
    throw new ImageParseError('WebP', 'the file is not a RIFF container whose form type is WEBP')
  }

  const declared = readU32LE(source, 4)
  if (declared + 8 !== source.length) {
    throw new ImageParseError(
      'WebP',
      `the RIFF header declares ${declared} bytes after itself while the file has ${source.length - 8}`,
    )
  }

  const parts: Uint8Array[] = []
  const containers: string[] = []
  let pos = 12
  let sawImageChunk = false
  /** Index into `parts` of the `VP8X` chunk, and its payload's first byte, for flag patching. */
  let vp8xIndex = -1

  while (pos < source.length) {
    if (pos + 8 > source.length) {
      throw new ImageParseError('WebP', `the file ends inside the chunk header at ${pos}`)
    }

    const type = printableType(ascii(source, pos, 4))
    const size = readU32LE(source, pos + 4)
    const dataEnd = pos + 8 + size
    const chunkEnd = dataEnd + (size % 2)

    if (dataEnd > source.length) {
      throw new ImageParseError(
        'WebP',
        `the ${type} chunk at ${pos} declares ${size} bytes and runs past the end of the file`,
      )
    }
    if (chunkEnd > source.length) {
      throw new ImageParseError(
        'WebP',
        `the ${type} chunk at ${pos} has an odd size and no room for its padding byte`,
      )
    }

    if (type === 'VP8 ' || type === 'VP8L' || type === 'VP8X') sawImageChunk = true

    if (type === 'EXIF') {
      containers.push('EXIF chunk')
    } else if (type === 'XMP ') {
      containers.push('XMP  chunk')
    } else {
      if (type === 'VP8X') vp8xIndex = parts.length
      parts.push(source.subarray(pos, chunkEnd))
    }

    pos = chunkEnd
  }

  if (pos !== source.length) {
    throw new ImageParseError('WebP', `the chunk list stops ${source.length - pos} bytes short of the end of the container`)
  }
  if (!sawImageChunk) throw new ImageParseError('WebP', 'the container holds no VP8, VP8L or VP8X image chunk')
  if (containers.length === 0) return unchanged('WebP', source)

  // Something went, so the container is rebuilt: header with a corrected size, then the
  // kept chunks, with VP8X's now-false metadata declarations cleared.
  const droppedExif = containers.includes('EXIF chunk')
  const droppedXmp = containers.includes('XMP  chunk')
  const body: Uint8Array[] = [asciiBytes('RIFF'), new Uint8Array(4), asciiBytes('WEBP'), ...parts]

  if (vp8xIndex !== -1) {
    const at = vp8xIndex + 3 // past 'RIFF', the size field, 'WEBP'
    const patched = Uint8Array.from(body[at])
    const flags = patched[VP8X_FLAGS_OFFSET]
    let cleared = flags
    if (droppedExif) cleared &= ~VP8X_FLAG_EXIF
    if (droppedXmp) cleared &= ~VP8X_FLAG_XMP
    patched[VP8X_FLAGS_OFFSET] = cleared & 0xff
    body[at] = patched
  }

  const total = body.reduce((sum, part) => sum + part.length, 0)
  const out = concat(body, total)
  const size = total - 8
  out[4] = size & 0xff
  out[5] = (size >>> 8) & 0xff
  out[6] = (size >>> 16) & 0xff
  out[7] = (size >>> 24) & 0xff

  return { format: 'WebP', bytes: out, removedBytes: source.length - out.length, containers }
}

// ── GIF ──────────────────────────────────────────────────────────────────────

/**
 * Nothing is stripped from a GIF, and that is a decision with a reason rather than an
 * omission.
 *
 * GIF has **no coordinate container.** Its metadata surface is the Comment Extension
 * (`0xFE`, free text), the Application Extension (`0xFF`, an 11-byte identifier plus
 * private payload — `NETSCAPE2.0` looping is the one everyone writes), and the Graphic
 * Control Extension, which is timing. There is no IFD, no rational, no tag registry
 * where a latitude can live. So there is nothing here that a phone photo needs taken
 * out, and a "GIF GPS stripper" would be a solution in search of a format.
 *
 * The one documented exception is XMP: Adobe's tools can put an RDF packet in an
 * Application Extension identified by `XMP DataXMP`, and XMP can carry coordinates.
 * Rather than parse and rewrite GIF blocks — a walk through sub-block chains that
 * would be the only place in this file with a chance of mangling an animation nobody
 * asked us to touch — a GIF containing an XMP or EXIF application extension is
 * **refused**, which is the same fail-closed rule every other branch here follows. The
 * detection is a 14-byte and a 7-byte literal; the odds of that byte sequence
 * appearing by chance inside LZW-compressed pixel data are about 2^-112 and 2^-56, so
 * this cannot refuse a real animation.
 *
 * Because no walk happens, a truncated GIF still passes exactly as it did before this
 * stage: GIF is the one format here where structure is not re-verified. That is the
 * asymmetry, stated.
 */
function stripGif(source: Uint8Array): StrippedImage {
  // 13 = the 6-byte magic plus the 7-byte logical screen descriptor, which is the
  // shortest thing that can call itself a GIF.
  if (source.length < 13 || !GIF_MAGICS.some((magic) => ascii(source, 0, 6) === magic)) {
    throw new ImageParseError('GIF', 'the file does not begin with GIF87a or GIF89a')
  }

  if (indexOfSequence(source, GIF_XMP_APPLICATION) !== -1 || indexOfSequence(source, GIF_EXIF_APPLICATION) !== -1) {
    throw new ImageParseError(
      'GIF',
      'an XMP or EXIF application extension was found, and this stripper rewrites no GIF blocks — re-save the image without metadata',
    )
  }

  return unchanged('GIF', source)
}
