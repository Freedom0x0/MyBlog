import { supabase } from '../lib/supabase';

export interface ArticleRecord {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  content_md: string;
  category: string;
  tags: string[];
  cover_image: string | null;
  read_time: number;
  created_at: string;
  updated_at: string;
}

export async function listArticles(): Promise<ArticleRecord[]> {
  const { data, error } = await supabase
    .from('articles')
    .select('*')
    .order('created_at', { ascending: false });

  if (error || !data) {
    return [];
  }
  return data as ArticleRecord[];
}

export async function getArticleBySlug(slug: string): Promise<ArticleRecord | null> {
  const { data, error } = await supabase
    .from('articles')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();

  if (error || !data) {
    return null;
  }
  return data as ArticleRecord;
}

export async function upsertArticle(input: {
  slug: string;
  title: string;
  excerpt: string;
  content_md: string;
  category: string;
  tags: string[];
  cover_image?: string | null;
  read_time?: number;
}): Promise<ArticleRecord | null> {
  const { data, error } = await supabase
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
      { onConflict: 'slug' }
    )
    .select('*')
    .single();

  if (error || !data) {
    return null;
  }
  return data as ArticleRecord;
}

