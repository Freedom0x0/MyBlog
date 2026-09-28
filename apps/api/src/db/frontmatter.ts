/**
 * Strict, deliberately small front-matter reader for seed fixtures.
 *
 * Not a YAML parser. The format is a flat `key: value` block with one array form,
 * and anything outside that is a hard error. A permissive parser would silently
 * accept `tags:\n  - a` as a string value and seed the wrong data; refusing is
 * the cheaper failure.
 *
 * This same file format is what S3's publish pipeline will consume, so the
 * fixtures below are not throwaway test scaffolding.
 */

export type ArticleStatus = 'draft' | 'published' | 'archived'

export interface Fixture {
  slug: string
  title: string
  excerpt: string
  category: string
  tags: string[]
  coverImage: string | null
  readTime: number
  status: ArticleStatus
  publishedAt: string | null
  body: string
}

const ALLOWED_KEYS = new Set([
  'slug',
  'title',
  'excerpt',
  'category',
  'tags',
  'coverImage',
  'readTime',
  'status',
  'publishedAt',
])

const REQUIRED_KEYS = ['slug', 'title', 'excerpt', 'category', 'tags', 'status'] as const

const STATUSES: readonly ArticleStatus[] = ['draft', 'published', 'archived']

export class FixtureError extends Error {}

/**
 * Mirrors the database's own `published_needs_timestamp` check.
 *
 * Both layers enforce it deliberately: the parser gives the developer a message
 * naming the file, the database guarantees it no matter which path wrote the row.
 */
function assertPublishedHasTimestamp(fixture: Fixture, source: string): void {
  if (fixture.status === 'published' && fixture.publishedAt === null) {
    throw new FixtureError(`${source}: status is 'published' but publishedAt is missing`)
  }
}

export function parseFixture(raw: string, source = '<string>'): Fixture {
  if (!raw.startsWith('---\n')) {
    throw new FixtureError(`${source}: fixture must begin with a '---' front-matter line`)
  }

  const end = raw.indexOf('\n---\n', 3)
  if (end === -1) {
    throw new FixtureError(`${source}: no closing '---' for the front-matter block`)
  }

  const head = raw.slice(4, end)
  // One character is consumed by the leading newline of the closing delimiter.
  const body = raw.slice(end + '\n---\n'.length).replace(/^\n/, '')

  const values = new Map<string, string>()

  for (const line of head.split('\n')) {
    if (line.trim() === '') continue

    // Indentation, comments and list syntax are YAML we do not support. Failing
    // loudly beats reading them as a scalar and seeding the wrong value.
    if (/^\s/.test(line)) {
      throw new FixtureError(`${source}: indented line is not supported: ${JSON.stringify(line)}`)
    }
    if (line.startsWith('#')) {
      throw new FixtureError(`${source}: comments are not supported: ${JSON.stringify(line)}`)
    }

    const separator = line.indexOf(':')
    if (separator === -1) {
      throw new FixtureError(`${source}: not a 'key: value' line: ${JSON.stringify(line)}`)
    }

    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()

    if (!ALLOWED_KEYS.has(key)) {
      throw new FixtureError(`${source}: unknown front-matter key '${key}'`)
    }
    if (values.has(key)) {
      throw new FixtureError(`${source}: duplicate key '${key}'`)
    }

    values.set(key, value)
  }

  for (const key of REQUIRED_KEYS) {
    if (!values.has(key)) {
      throw new FixtureError(`${source}: missing required key '${key}'`)
    }
  }

  const status = values.get('status')
  if (!status || !(STATUSES as readonly string[]).includes(status)) {
    throw new FixtureError(
      `${source}: status must be one of ${STATUSES.join(', ')}; got ${JSON.stringify(status ?? null)}`,
    )
  }

  const readTimeRaw = values.get('readTime')
  let readTime = 5
  if (readTimeRaw !== undefined) {
    readTime = Number(readTimeRaw)
    if (!Number.isInteger(readTime) || readTime <= 0) {
      throw new FixtureError(`${source}: readTime must be a positive integer, got ${JSON.stringify(readTimeRaw)}`)
    }
  }

  const tagsRaw = values.get('tags') ?? ''
  const tags = tagsRaw.startsWith('[') && tagsRaw.endsWith(']')
    ? tagsRaw
        .slice(1, -1)
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag !== '')
    : (() => {
        throw new FixtureError(
          `${source}: tags must use the [a, b] form, got ${JSON.stringify(tagsRaw)}`,
        )
      })()

  const coverImage = values.get('coverImage')
  const publishedAt = values.get('publishedAt')

  const fixture: Fixture = {
    slug: values.get('slug')!,
    title: values.get('title')!,
    excerpt: values.get('excerpt')!,
    category: values.get('category')!,
    tags,
    coverImage: coverImage === undefined || coverImage === 'null' ? null : coverImage,
    readTime,
    status: status as ArticleStatus,
    publishedAt: publishedAt === undefined || publishedAt === 'null' ? null : publishedAt,
    body,
  }

  assertPublishedHasTimestamp(fixture, source)

  return fixture
}
