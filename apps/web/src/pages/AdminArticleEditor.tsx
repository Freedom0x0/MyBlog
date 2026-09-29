import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import MDEditor from '@uiw/react-md-editor';
import rehypeSanitize from 'rehype-sanitize';
import { useAuthStore } from '../store/authStore';
import { createArticle, getAdminArticle, updateArticle } from '../utils/articlesApi';
import { ApiError, describeApiError } from '../lib/apiClient';
import type { ArticleAdmin } from 'shared';

/**
 * Admin-only article editor: draft writes and the publish transition, against the
 * portal API.
 *
 * Two buttons, not one, because the API has two rules. Creating can never publish
 * (`CreateArticleInput` has no `status` field), and only `PATCH` moves `status`.
 * The old single "发布/保存" button did both at once against the previous store,
 * which is the behaviour this page no longer has — and must not reimplement
 * client-side by quietly sending a status on create or publishing right after
 * saving.
 */

/** The form's fields, in the shape the write endpoints take. */
interface DraftForm {
  slug: string;
  title: string;
  excerpt: string;
  content: string;
  category: string;
  tags: string[];
  coverImage: string | null;
  readTime: number;
}

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  published: '已发布',
  archived: '已归档',
};

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * The same eight fields, read back off an API response.
 *
 * Used for the "is this saved?" comparison, and it has to be built here rather
 * than trusted from the form state, because the server is allowed to answer with
 * something other than what was sent — a normalised slug, a stripped tag. The
 * snapshot is then the row's truth, and `dirty` means "differs from the row",
 * which is the only claim the publish button needs to rest on.
 */
function formOf(article: ArticleAdmin): DraftForm {
  return {
    slug: article.slug,
    title: article.title,
    excerpt: article.excerpt,
    content: article.content,
    category: article.category,
    /**
     * Through the display string and back on purpose. The form's tags value is one
     * comma-joined text field, so "what this screen currently expresses" is only
     * comparable to the row after the same pass; a tag containing a comma is not
     * expressible here at all, and comparing against the raw row would leave the
     * page claiming unsaved changes forever.
     */
    tags: (article.tags ?? [])
      .join(', ')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    coverImage: article.coverImage,
    readTime: article.readTime,
  };
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
  const [publishing, setPublishing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  /** The form as it was last successfully written, for the dirty check. */
  const [savedForm, setSavedForm] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const currentForm = useMemo<DraftForm>(
    () => ({
      /**
       * A slug the admin typed is used as written; only the derived one is
       * slugified. Running `slugify` over an explicit value would make the form
       * disagree with the row it just loaded (`My_Note` → `mynote`), which the
       * dirty check below would then report as an unsaved change on first paint.
       */
      slug: slugInput.trim() ? slugInput.trim() : slugify(title),
      title: title.trim(),
      excerpt: excerpt.trim(),
      content,
      category: category.trim(),
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      coverImage: coverImage.trim() ? coverImage.trim() : null,
      readTime,
    }),
    [slugInput, title, excerpt, content, category, tags, coverImage, readTime],
  );

  const dirty = savedForm !== null && JSON.stringify(currentForm) !== savedForm;
  const canSubmit =
    isAdmin &&
    title.trim() !== '' &&
    currentForm.slug !== '' &&
    content.trim() !== '' &&
    excerpt.trim() !== '' &&
    category.trim() !== '';

  useEffect(() => {
    if (!isEdit || !slug) return;
    const load = async () => {
      setLoading(true);
      setErrorMessage(null);
      try {
        /**
         * The admin read, not the public one.
         *
         * `GET /articles/:slug` answers 404 for a draft to everybody, including
         * the admin who wrote it, so an editor that used it showed a blank *new*
         * form for an existing draft — the shape of defect D0. `ArticleAdmin`
         * carries the body and the status, which is what this page renders.
         */
        const article = await getAdminArticle(slug);
        setTitle(article.title);
        setSlugInput(article.slug);
        setExcerpt(article.excerpt);
        setCategory(article.category);
        setTags((article.tags || []).join(', '));
        setCoverImage(article.coverImage ?? '');
        setReadTime(article.readTime ?? 5);
        setContent(article.content);
        setStatus(article.status);
        setSavedForm(JSON.stringify(formOf(article)));
      } catch (error) {
        // A failed load is reported, not turned into an empty form: writing here
        // would then PATCH the article the load failed to show.
        if (error instanceof ApiError && error.status === 404) {
          setErrorMessage(`找不到这篇文章（${slug}）。它可能已被删除。`);
        } else {
          setErrorMessage(describeApiError(error, '文章加载失败，请重试。'));
        }
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [isEdit, slug]);

  /** 保存 = create (a draft) or patch (everything except status). */
  const handleSave = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setErrorMessage(null);
    setNotice(null);

    // A rename is the only case that puts `slug` in the patch body: with it equal
    // to the address we are on, leaving it out keeps "did this change the URL?"
    // readable straight off the request.
    const renaming = isEdit && slug !== undefined && currentForm.slug !== slug;

    try {
      const saved: ArticleAdmin =
        isEdit && slug
          ? await updateArticle(slug, {
              title: currentForm.title,
              excerpt: currentForm.excerpt,
              content: currentForm.content,
              category: currentForm.category,
              tags: currentForm.tags,
              coverImage: currentForm.coverImage,
              readTime: currentForm.readTime,
              ...(renaming ? { slug: currentForm.slug } : {}),
            })
          : await createArticle(currentForm);

      setStatus(saved.status);
      setSavedForm(JSON.stringify(formOf(saved)));

      if (!isEdit) {
        // Land on the edit route for the row that now exists, so the URL, the
        // publish button and a refresh all agree. Navigating to the public detail
        // page instead would show "文章未找到" — correct for a draft, useless for
        // the person who just wrote one.
        navigate(`/admin/articles/${encodeURIComponent(saved.slug)}/edit`);
        setNotice('草稿已保存。公开列表还看不到它——点「发布」才会公开。');
      } else {
        // Wording follows the status the server answered, not the button pressed:
        // saving a published article leaves it published, and calling that "草稿已保存"
        // would make the author go looking for a draft that does not exist.
        setNotice(
          saved.status === 'published'
            ? renaming
              ? `已保存，文章仍在发布状态，地址改为 /blog/${saved.slug}。`
              : '已保存，文章仍在发布状态。'
            : '草稿已保存。',
        );
        if (renaming) navigate(`/admin/articles/${encodeURIComponent(saved.slug)}/edit`);
      }
    } catch (error) {
      /**
       * Failure is shown and the form is left exactly as it was.
       *
       * The path this replaced answered a failed write with `null`, and the caller
       * then applied the edit to local state and closed the editor, so the screen
       * said "saved" about a row that had not changed. There is no such fallback
       * here: nothing written, nothing applied, and the API's own message names the
       * reason.
       */
      setErrorMessage(describeApiError(error, '保存失败，请重试。'));
    } finally {
      setSaving(false);
    }
  };

  /**
   * 发布 = a patch whose only field is `status`.
   *
   * It never carries the body, and saving never carries this field: the transition
   * lives on `PATCH` alone server-side (design §1.1), and if this button also
   * pushed content the two rules would be in two places again. Blocked while the
   * form is dirty for that reason — publishing an old row while the new text sits
   * in the browser is exactly the "looks done, isn't" failure this stage removes.
   */
  const handlePublish = async () => {
    if (!isEdit || !slug) return;
    setPublishing(true);
    setErrorMessage(null);

    try {
      const saved = await updateArticle(slug, { status: 'published' });
      setStatus(saved.status);
      setSavedForm(JSON.stringify(formOf(saved)));
      navigate(`/blog/${encodeURIComponent(saved.slug)}`);
    } catch (error) {
      setErrorMessage(describeApiError(error, '发布失败，请重试。'));
    } finally {
      setPublishing(false);
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
            <div className="text-2xl font-bold flex items-center gap-3">
              {isEdit ? '编辑文章' : '新建文章'}
              {status && (
                <span className="text-xs font-medium px-2 py-1 rounded-full border border-border text-muted-foreground">
                  当前：{STATUS_LABELS[status] ?? status}
                </span>
              )}
            </div>
            <div className="text-sm text-muted-foreground">
              保存到自建 API。「保存」只写草稿，「发布」才会让它出现在公开列表。
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link
              to={isEdit && slug ? `/blog/${slug}` : '/'}
              className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md"
            >
              返回
            </Link>
            {!isEdit && (
              /**
               * Disabled rather than hidden, and explained: a first-time author
               * clicking it needs to learn the two-step model, not wonder where the
               * publish button went. The row does not exist until 保存 creates it.
               */
              <span className="text-xs text-muted-foreground max-w-[10rem]">
                新建的文章要先保存成草稿，才能发布。
              </span>
            )}
            <button
              onClick={handlePublish}
              disabled={!isEdit || !canSubmit || publishing || saving || dirty}
              title={dirty ? '有未保存的修改，先保存再发布' : undefined}
              className="px-4 py-2 bg-green-600 text-white rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {publishing ? '发布中...' : '发布'}
            </button>
            <button
              onClick={handleSave}
              disabled={!canSubmit || saving || publishing}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {/* "保存草稿" only while the row is a draft: the same patch against a
                  published article leaves it published, so promising a draft there
                  would be the wrong label on the right button. */}
              {saving ? '保存中...' : status === 'published' ? '保存修改' : '保存草稿'}
            </button>
          </div>
        </div>

        {dirty && (
          <div className="mb-4 text-sm px-4 py-2 rounded-md bg-amber-500/10 text-amber-600 border border-amber-500/30">
            有未保存的修改。
          </div>
        )}

        {notice && (
          <div className="mb-4 text-sm px-4 py-2 rounded-md bg-green-500/10 text-green-600 border border-green-500/30">
            {notice}
          </div>
        )}

        {errorMessage && (
          /**
           * The write path used to fail into `localStorage` and close the editor;
           * this box is what replaces that. Content stays on the screen so the
           * attempt can be corrected and retried.
           */
          <div className="mb-4 text-sm px-4 py-2 rounded-md bg-red-500/10 text-red-600 border border-red-500/30">
            {errorMessage}
          </div>
        )}

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
                  {/* Still a URL the admin types. Uploading is stage F, and it does
                      not change this field: the column stores a URL either way. */}
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
