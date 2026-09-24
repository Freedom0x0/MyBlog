import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import MDEditor from '@uiw/react-md-editor';
import rehypeSanitize from 'rehype-sanitize';
import { useAuthStore } from '../store/authStore';
import { getArticleBySlug, upsertArticle } from '../utils/articlesApi';

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export default function AdminArticleEditor() {
  const { slug } = useParams<{ slug?: string }>();
  const navigate = useNavigate();
  const { isAdmin } = useAuthStore();

  const isEdit = useMemo(() => Boolean(slug), [slug]);

  const [title, setTitle] = useState('');
  const [slugInput, setSlugInput] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  const [coverImage, setCoverImage] = useState('');
  const [readTime, setReadTime] = useState(5);
  const [content, setContent] = useState('# 新文章\n\n从这里开始写作...');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isEdit || !slug) return;
    const load = async () => {
      setLoading(true);
      const record = await getArticleBySlug(slug);
      if (record) {
        setTitle(record.title);
        setSlugInput(record.slug);
        setExcerpt(record.excerpt);
        setCategory(record.category);
        setTags((record.tags || []).join(', '));
        setCoverImage(record.cover_image ?? '');
        setReadTime(record.read_time ?? 5);
        setContent(record.content_md);
      }
      setLoading(false);
    };
    load();
  }, [isEdit, slug]);

  const canSubmit = isAdmin && title.trim() && (slugInput.trim() || title.trim()) && content.trim() && excerpt.trim() && category.trim();

  const handleSave = async () => {
    if (!canSubmit) return;
    setSaving(true);
    const finalSlug = slugInput.trim() ? slugify(slugInput) : slugify(title);
    const finalTags = tags
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);

    const saved = await upsertArticle({
      slug: finalSlug,
      title: title.trim(),
      excerpt: excerpt.trim(),
      content_md: content,
      category: category.trim(),
      tags: finalTags,
      cover_image: coverImage.trim() ? coverImage.trim() : null,
      read_time: readTime,
    });
    setSaving(false);

    if (saved) {
      navigate(`/blog/${saved.slug}`);
    }
  };

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center px-4">
        <div className="max-w-md w-full bg-card border border-border rounded-xl p-6 text-center">
          <div className="text-lg font-semibold mb-2">需要管理员权限</div>
          <div className="text-sm text-muted-foreground mb-4">请使用管理员账号登录后再访问。</div>
          <Link to="/" className="inline-flex px-4 py-2 bg-primary text-primary-foreground rounded-md">返回首页</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground px-4 py-10">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="text-2xl font-bold">{isEdit ? '编辑文章' : '新建文章'}</div>
            <div className="text-sm text-muted-foreground">发布后会同步保存到 Supabase。</div>
          </div>
          <div className="flex items-center gap-3">
            <Link
              to={isEdit && slug ? `/blog/${slug}` : '/'}
              className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md"
            >
              返回
            </Link>
            <button
              onClick={handleSave}
              disabled={!canSubmit || saving}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? '保存中...' : '发布/保存'}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-10">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-1 space-y-4">
              <div className="bg-card border border-border rounded-xl p-4">
                <div className="text-sm font-medium mb-2">标题</div>
                <input
                  value={title}
                  onChange={e => {
                    setTitle(e.target.value);
                    if (!isEdit && !slugInput.trim()) {
                      setSlugInput(slugify(e.target.value));
                    }
                  }}
                  className="w-full bg-background border border-border rounded-md px-3 py-2"
                />
              </div>

              <div className="bg-card border border-border rounded-xl p-4">
                <div className="text-sm font-medium mb-2">Slug（URL）</div>
                <input
                  value={slugInput}
                  onChange={e => setSlugInput(e.target.value)}
                  className="w-full bg-background border border-border rounded-md px-3 py-2"
                />
              </div>

              <div className="bg-card border border-border rounded-xl p-4">
                <div className="text-sm font-medium mb-2">摘要</div>
                <textarea
                  value={excerpt}
                  onChange={e => setExcerpt(e.target.value)}
                  className="w-full bg-background border border-border rounded-md px-3 py-2 min-h-[100px]"
                />
              </div>

              <div className="bg-card border border-border rounded-xl p-4 space-y-3">
                <div>
                  <div className="text-sm font-medium mb-2">分类</div>
                  <input
                    value={category}
                    onChange={e => setCategory(e.target.value)}
                    className="w-full bg-background border border-border rounded-md px-3 py-2"
                  />
                </div>
                <div>
                  <div className="text-sm font-medium mb-2">标签（逗号分隔）</div>
                  <input
                    value={tags}
                    onChange={e => setTags(e.target.value)}
                    className="w-full bg-background border border-border rounded-md px-3 py-2"
                  />
                </div>
                <div>
                  <div className="text-sm font-medium mb-2">封面图 URL</div>
                  <input
                    value={coverImage}
                    onChange={e => setCoverImage(e.target.value)}
                    className="w-full bg-background border border-border rounded-md px-3 py-2"
                  />
                </div>
                <div>
                  <div className="text-sm font-medium mb-2">阅读时长（分钟）</div>
                  <input
                    type="number"
                    min={1}
                    value={readTime}
                    onChange={e => setReadTime(Math.max(1, Number(e.target.value || 1)))}
                    className="w-full bg-background border border-border rounded-md px-3 py-2"
                  />
                </div>
              </div>
            </div>

            <div className="lg:col-span-2">
              <div className="bg-card border border-border rounded-xl p-4" data-color-mode={document.documentElement.classList.contains('dark') ? 'dark' : 'light'}>
                <MDEditor
                  value={content}
                  onChange={val => setContent(val || '')}
                  previewOptions={{
                    rehypePlugins: [[rehypeSanitize]],
                  }}
                  height={700}
                  className="!bg-background"
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

