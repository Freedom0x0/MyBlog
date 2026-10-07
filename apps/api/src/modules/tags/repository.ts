import type { Pool } from 'pg'
import type { TagCount } from 'shared'

/**
 * Tags are not a table. At blog scale — tens of them, always read together with
 * their articles — `articles.tags text[]` plus a GIN index answers both the
 * containment filter and this aggregate, without a join table to keep in sync.
 */
export class TagRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * `count(*)::text` rather than `count(*)`: node-pg maps bigint to a JS number,
   * which is silently wrong past 2^53. Not a live risk for tag counts, but the
   * cast documents that the column is an exact integer and keeps the mapping to a
   * JS float out of the path.
   */
  async listWithCounts(): Promise<TagCount[]> {
    const result = await this.pool.query<{ tag: string; count: string }>(
      `select tag, count(*)::text as count
         from articles, unnest(tags) as tag
         where status = 'published'
         group by tag
         order by count(*) desc, tag asc`,
    )

    return result.rows.map((row) => ({ tag: row.tag, count: Number(row.count) }))
  }
}
