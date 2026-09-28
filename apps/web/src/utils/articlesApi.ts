import { getSupabase } from '../lib/supabase'
import { apiGet, ApiError } from '../lib/apiClient'
import type { ArticleDetail, ArticlePage, ArticleSummary } from 'shared'

/**
 * Shape accepted by the write path, which still goes to Supabase until S3.
 *
 * Reads no longer use this type: they come back as the camelCase DTOs the API
 * publishes. Keeping both is the transitional cost of replacing the write path
 * separately from the read path; it disappears in S3.
 */
export interface ArticleRecord {
  slug: string
  title: string
  excerpt: string
  content_md: string
  category: string
  tags: string[]
  cover_image?: string | null
  read_time?: number
}

const LIST_LIMIT = 50

export async function listArticles(): Promise<ArticleSummary[]> {
  const page = await apiGet<ArticlePage>(`/articles?limit=${LIST_LIMIT}`)
  return page.data
}

/**
 * `null` means "no published article with that slug".
 *
 * The API answers 404 for missing *and* unpublished on purpose, so this cannot
 * tell a draft apart from a typo — which is correct for a public client.
 */
export async function getArticleBySlug(slug: string): Promise<ArticleDetail | null> {
  try {
    return await apiGet<ArticleDetail>(`/articles/${encodeURIComponent(slug)}`)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

export async function upsertArticle(input: ArticleRecord): Promise<ArticleRecord | null> {
  const { data, error } = await getSupabase()
    .from('articles')
    .upsert(
      {
        slug: input.slug,
        title: input.title,
        excerpt: input.excerpt,
        content_md: input.content_md,
        category: input.category,
        tags: input.tags,
        cover_image: input.cover_image ?? null,
        read_time: input.read_time ?? 5,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'slug' },
    )
    .select('*')
    .single()

  if (error || !data) {
    return null
  }
  return data as ArticleRecord
}
