import { describe, expect, it } from 'vitest'
import { FixtureError, parseFixture } from './frontmatter.js'

const minimal = `---
slug: a
title: A
excerpt: E
category: C
tags: [x, y]
status: published
publishedAt: 2026-09-20T10:00:00Z
---
body text
`

describe('parseFixture', () => {
  it('parses the happy path', () => {
    const fixture = parseFixture(minimal)

    expect(fixture).toMatchObject({
      slug: 'a',
      title: 'A',
      tags: ['x', 'y'],
      status: 'published',
      coverImage: null,
      readTime: 5,
    })
    expect(fixture.body).toBe('body text\n')
  })

  it('defaults coverImage and readTime, keeps an explicit readTime', () => {
    expect(parseFixture(minimal.replace('status: published', 'readTime: 9\nstatus: draft')).readTime).toBe(9)
  })

  /**
   * The point of these fixtures: characters that broke the old Supabase
   * migration must survive parsing untouched, because they are then handed to
   * Postgres verbatim.
   */
  it.each([
    ["ASCII apostrophes", "const s = 'demo'\ndon't stop\n"],
    ['dollar tags', '$md$ and $$ and $SQL$\n'],
    ['backslashes', 'C:\\tmp\\x and \\d+ and \\n\n'],
    ['CJK and emoji', '中文テキスト👨‍👩‍👧‍👦🏳️‍🌈\n'],
  ])('preserves body verbatim: %s', (_label, body) => {
    const fixture = parseFixture(`---\nslug: a\ntitle: t\nexcerpt: e\ncategory: c\ntags: []\nstatus: draft\n---\n${body}`)

    expect(fixture.body).toBe(body)
  })

  it('treats a --- line inside the body as content, not as the delimiter', () => {
    // indexOf finds the FIRST closing fence, so a later horizontal rule is content.
    const raw = `---\nslug: a\ntitle: t\nexcerpt: e\ncategory: c\ntags: []\nstatus: draft\n---\nbefore\n\n---\n\nafter\n`

    expect(parseFixture(raw).body).toBe('before\n\n---\n\nafter\n')
  })

  it('rejects anything outside the supported flat subset', () => {
    const cases: Array<[string, RegExp]> = [
      ['no opening fence', /must begin with a '---'/],
      [`---\nslug: a\n`, /no closing '---'/],
      [`---\n  slug: a\ntitle: t\nexcerpt: e\ncategory: c\ntags: []\nstatus: draft\n---\nx\n`, /indented line/],
      [`---\n# note\nslug: a\ntitle: t\nexcerpt: e\ncategory: c\ntags: []\nstatus: draft\n---\nx\n`, /comments are not supported/],
      [`---\nslug: a\ntitle: t\nexcerpt: e\ncategory: c\ntags: []\nstatus: draft\nextra: 1\n---\nx\n`, /unknown front-matter key 'extra'/],
      [`---\nslug: a\nslug: b\n---\n`, /duplicate key 'slug'/],
      [`---\nslug: a\n---\n`, /missing required key 'title'/],
      [`---\nslug: a\ntitle: t\nexcerpt: e\ncategory: c\ntags: []\nstatus: wip\n---\nx\n`, /status must be one of/],
      [`---\nslug: a\ntitle: t\nexcerpt: e\ncategory: c\ntags: bare\nstatus: draft\n---\nx\n`, /tags must use the \[a, b\] form/],
      [`---\nslug: a\ntitle: t\nexcerpt: e\ncategory: c\ntags: []\nstatus: draft\nreadTime: -2\n---\nx\n`, /readTime must be a positive integer/],
    ]

    for (const [raw, expected] of cases) {
      expect(() => parseFixture(raw)).toThrow(FixtureError)
      expect(() => parseFixture(raw)).toThrow(expected)
    }
  })

  it('rejects published without publishedAt, mirroring the DB constraint', () => {
    expect(() =>
      parseFixture(`---\nslug: a\ntitle: t\nexcerpt: e\ncategory: c\ntags: []\nstatus: published\n---\nx\n`),
    ).toThrow(/status is 'published' but publishedAt is missing/)
  })

  it('names the offending file in the error', () => {
    expect(() => parseFixture('junk', 'fixtures/broken.md')).toThrow(/fixtures\/broken\.md/)
  })
})
