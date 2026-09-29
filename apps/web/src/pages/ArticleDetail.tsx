import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { ArrowLeft, Clock, Calendar, Tag, Edit, Save, X, MessageSquare } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import MDEditor from '@uiw/react-md-editor';
import rehypeSanitize from 'rehype-sanitize';
import { getAdminArticle, getArticleBySlug, updateArticle } from '../utils/articlesApi';
import { listComments } from '../utils/commentsApi';
import { loginUrl } from '../utils/authApi';
import { describeApiError, ApiError } from '../lib/apiClient';
import type { ArticleDetail as PublicArticle, ArticleAdmin, CommentNode } from 'shared';

/**
 * The page renders one of two shapes, and both are the API's, not a local copy.
 *
 * `ArticleDetail` is what the public endpoint answers; `ArticleAdmin` is what the
 * admin endpoint answers for the same slug — the same fields plus `status` and
 * `updatedAt`, with `publishedAt` nullable because a draft has none. Every reader
 * gets the public shape, so `status` is narrowed with `in` where it is used.
 *
 * There used to be a third shape here: a hand-written `Article` interface that
 * declared `coverImage: string` (non-null) and a `createdAt: string` no endpoint
 * returns. The non-null cover is why the page passed `''` into `<img src>` and the
 * extra field is why it read `record.publishedAt` through a rename. Both were
 * silenced by the local type rather than handled; dropping it makes the API's
 * nullability show up at the two places that have to deal with it.
 */


const ArticleDetail: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const [article, setArticle] = useState<PublicArticle | ArticleAdmin | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState('');
  const [loadingArticle, setLoadingArticle] = useState(true);
  const [saving, setSaving] = useState(false);
  /** Set when a write failed; the editor stays open with the text intact. */
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const { user, isAdmin } = useAuthStore();
  const [comments, setComments] = useState<CommentNode[]>([]);
  const [loadingComments, setLoadingComments] = useState(true);

  useEffect(() => {
    if (!slug) return;

    const load = async () => {
      setLoadingArticle(true);
      setLoadError(null);
      try {
        /**
         * An admin reads through the admin endpoint.
         *
         * The public one answers 404 for a draft to everyone — including the admin
         * who wrote it — and "文章未找到" under a freshly saved draft reads like the
         * article was lost. Same slug, same content, plus `status`, so the page can
         * say 草稿 instead of guessing.
         */
        if (isAdmin) {
          const adminView = await getAdminArticle(slug);
          setArticle(adminView);
          setEditedContent(adminView.content);
          return;
        }

        const record = await getArticleBySlug(slug);

        if (!record) {
          // Leave `article` null so the `!article` guard below renders
          // "文章未找到". This path used to fall back to hardcoded mock data, so
          // any unknown slug displayed invented content instead of saying no.
          return;
        }

        setArticle(record);
        setEditedContent(record.content);
      } catch (error) {
        setArticle(null);
        // A 404 here is "this slug is not an article you can read", which the
        // `!article` guard below already says; anything else is a fault worth
        // naming, because the same guard would otherwise blame the reader.
        if (error instanceof ApiError && error.status === 404) return;
        setLoadError(describeApiError(error, '文章加载失败，请重试。'));
      } finally {
        setLoadingArticle(false);
      }
    };

    load();
  }, [slug, isAdmin]);

  useEffect(() => {
    if (!slug) return;

    // Defined inside the effect because nothing else calls it. Hoisting it out
    // would leave the effect with a dependency it cannot honestly declare
    // (the function is recreated every render), which is what the
    // exhaustive-deps warning was pointing at.
    const fetchComments = async () => {
      setLoadingComments(true);
      try {
        setComments(await listComments(slug));
      } catch (error) {
        // A failed comment read must not take the article page down: the article
        // has already rendered, so degrade this panel instead of blanking it.
        console.error('comments load failed', error);
        setComments([]);
      } finally {
        setLoadingComments(false);
      }
    };

    fetchComments();
  }, [slug]);

  /**
   * Quick edit saves the body through `PATCH /articles/:slug`.
   *
   * Only `content` travels: this is the field the panel edits, and the status rule
   * says a plain content patch must not name one. Publishing is the editor's job.
   */
  const handleSave = async () => {
    if (!article || !slug) return;
    if (!isAdmin) return;

    setSaving(true);
    setSaveError(null);
    setSaveNotice(null);

    try {
      const saved = await updateArticle(slug, { content: editedContent });
      // The server's row replaces the local one, so what the page shows after this
      // is what is stored — including `status`, which is how a draft that just got
      // its first publish elsewhere stays labelled here.
      setArticle(saved);
      setEditedContent(saved.content);
      setIsEditing(false);
      setSaveNotice(
        saved.status === 'draft'
          ? '正文已保存。这篇仍是草稿，公开访问看不到它。'
          : '正文已保存。',
      );
    } catch (error) {
      /**
       * The failure is shown and nothing is applied.
       *
       * This block used to fall through to `setArticle({...article, content:
       * editedContent})` plus `localStorage.setItem(...)`, so a rejected write left
       * the reader looking at the new text and a stored note, while the row in the
       * database still held the old one. There is no local fallback now: the text
       * stays in the open editor, the API's own message says why, and retrying is
       * possible without losing what was typed.
       */
      setSaveError(describeApiError(error, '保存失败，请重试。'));
    } finally {
      setSaving(false);
    }
  };

  if (loadingArticle) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background text-foreground">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!article) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background text-foreground">
        <h1 className="text-4xl font-bold mb-4">{loadError ? '文章读取失败' : '文章未找到'}</h1>
        {loadError && <p className="mb-4 text-muted-foreground">{loadError}</p>}
        <Link to="/" className="text-primary hover:underline">返回首页</Link>
      </div>
    );
  }

  /**
   * `status` exists only on the admin shape, so the draft marker is a narrowing
   * check rather than a field the public response is asked to invent. A reader
   * who is not an admin can never reach a draft in the first place.
   */
  const isDraft = 'status' in article && article.status === 'draft';

  return (
    <div className="min-h-screen bg-background text-foreground selection:bg-primary/30">
      {/* Header Image */}
      <div className="relative h-[40vh] md:h-[60vh] w-full overflow-hidden">
        {article.coverImage ? (
          <img
            src={article.coverImage}
            alt={article.title}
            className="w-full h-full object-cover"
          />
        ) : (
          /**
           * `coverImage` is nullable in the contract — the column is nullable and
           * the API answers `null`, not `''`. The local type used to call it a
           * `string`, so this page passed an empty `src` to `<img>` and got the
           * browser's broken-image placeholder where a plain gradient belongs.
           */
          <div className="w-full h-full bg-gradient-to-br from-muted to-secondary" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/50 to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 max-w-4xl mx-auto px-4 pb-8">
          <Link
            to="/"
            className="inline-flex items-center text-muted-foreground hover:text-foreground mb-6 transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            返回首页
          </Link>
          <div className="flex items-center justify-between mb-6">
            <div>
              {isDraft && (
                /**
                 * The marker is the point of reading through the admin endpoint:
                 * without it a draft looks identical to a published article, and an
                 * admin who then shared the link would get "文章未找到" back and have
                 * no way to know which half went wrong.
                 */
                <div className="inline-flex items-center mb-3 text-xs font-medium px-2 py-1 rounded-full bg-amber-500/20 text-amber-600 border border-amber-500/40">
                  草稿 · 仅管理员可见
                </div>
              )}
              <h1 className="text-3xl md:text-5xl font-bold text-foreground">
                {article.title}
              </h1>
            </div>
            {isAdmin && !isEditing && (
              <div className="flex items-center gap-2">
                <Link
                  to={`/admin/articles/${article.slug}/edit`}
                  className="flex items-center space-x-2 bg-primary/20 text-primary px-4 py-2 rounded-md hover:bg-primary/30 transition-colors"
                >
                  <Edit className="w-4 h-4" />
                  <span>进入编辑器</span>
                </Link>
                <button
                  onClick={() => setIsEditing(true)}
                  className="flex items-center space-x-2 bg-secondary text-secondary-foreground px-4 py-2 rounded-md hover:bg-accent transition-colors"
                >
                  <Edit className="w-4 h-4" />
                  <span>快速编辑</span>
                </button>
              </div>
            )}
            {isAdmin && isEditing && (
              <div className="flex items-center space-x-2">
                <button 
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center space-x-2 bg-green-500/20 text-green-500 px-4 py-2 rounded-md hover:bg-green-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Save className="w-4 h-4" />
                  <span>{saving ? '保存中...' : '保存'}</span>
                </button>
                <button 
                  onClick={() => {
                    setIsEditing(false);
                    setEditedContent(article.content);
                    setSaveError(null);
                  }}
                  className="flex items-center space-x-2 bg-red-500/20 text-red-500 px-4 py-2 rounded-md hover:bg-red-500/30 transition-colors"
                >
                  <X className="w-4 h-4" />
                  <span>取消</span>
                </button>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-6 text-sm text-muted-foreground">
            <div className="flex items-center">
              <Calendar className="w-4 h-4 mr-2" />
              {article.publishedAt
                ? new Date(article.publishedAt).toLocaleDateString('zh-CN')
                : /**
                   * The first place the nullable `publishedAt` is actually handled.
                   * `new Date(null)` is 1970-01-01, and the old local type hid the
                   * nullability by renaming the field instead.
                   */
                  '未发布'}
            </div>
            <div className="flex items-center">
              <Clock className="w-4 h-4 mr-2" />
              {article.readTime} 分钟阅读
            </div>
            <div className="flex items-center">
              <Tag className="w-4 h-4 mr-2" />
              {article.category}
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <main className="max-w-4xl mx-auto px-4 py-12">
        {saveError && (
          <div className="mb-6 text-sm px-4 py-3 rounded-md bg-red-500/10 text-red-600 border border-red-500/30">
            保存失败：{saveError}
            <div className="mt-1 text-xs opacity-80">
              下面的内容还没有写进服务器，改好后可以再点一次保存。
            </div>
          </div>
        )}
        {saveNotice && (
          <div className="mb-6 text-sm px-4 py-3 rounded-md bg-green-500/10 text-green-600 border border-green-500/30">
            {saveNotice}
          </div>
        )}
        {isEditing ? (
          <div className="bg-card p-4 rounded-xl border border-border" data-color-mode={document.documentElement.classList.contains('dark') ? 'dark' : 'light'}>
            <MDEditor
              value={editedContent}
              onChange={(val) => setEditedContent(val || '')}
              previewOptions={{
                rehypePlugins: [[rehypeSanitize]],
              }}
              height={600}
              className="!bg-background"
            />
          </div>
        ) : (
          <article className="prose prose-neutral dark:prose-invert prose-blue max-w-none">
            <ReactMarkdown
              components={{
                // `node` is destructured only to keep it out of `...props`.
                // Spreading react-markdown's AST node onto a DOM element would
                // make React log an unknown-prop warning.
                code({ node: _node, className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || '');
                  return match ? (
                    // `...props` is deliberately NOT spread here. Those are
                    // HTML `<code>` attributes, and SyntaxHighlighter's `style`
                    // means something entirely different — the highlight theme.
                    // Passing them through let an element style override the
                    // theme object.
                    <SyntaxHighlighter
                      style={vscDarkPlus}
                      language={match[1]}
                      PreTag="div"
                    >
                      {String(children).replace(/\n$/, '')}
                    </SyntaxHighlighter>
                  ) : (
                    <code className={className} {...props}>
                      {children}
                    </code>
                  );
                },
              }}
            >
              {article.content}
            </ReactMarkdown>
          </article>
        )}

        {/* Footer Tags */}
        <div className="mt-12 pt-8 border-t border-border">
          <div className="flex flex-wrap gap-2">
            {article.tags.map((tag) => (
              <span
                key={tag}
                className="px-3 py-1 bg-secondary text-secondary-foreground text-xs rounded-full border border-border"
              >
                #{tag}
              </span>
            ))}
          </div>
        </div>

        {/* Comments Section */}
        <div className="mt-16">
          <h3 className="text-2xl font-bold mb-8 flex items-center">
            <MessageSquare className="w-6 h-6 mr-3 text-primary" />
            评论 ({comments.length})
          </h3>

          {user ? (
            /**
             * Still read-only, and still said out loud rather than left to fail.
             *
             * The API now answers `POST /articles/:slug/comments` and
             * `DELETE /comments/:id`, and `utils/commentsApi` has the two calls, but
             * the input box and the delete buttons are not wired to them yet — that
             * belongs with the admin list page in the next cut (implement.md D-2 /
             * S3-R17). Deleting here would otherwise be a silent no-op, which is the
             * failure this notice exists to prevent.
             */
            <div className="mb-10 bg-card/50 p-4 rounded-xl border border-border text-center text-muted-foreground">
              评论与发表的写入功能正在迁移到新的后端，暂时只读。已发表的评论可正常查看。
            </div>
          ) : (
            <div className="mb-10 bg-card/50 p-6 rounded-xl border border-border text-center">
              <p className="text-muted-foreground mb-4">登录后参与讨论</p>
              <button
                onClick={() => window.location.assign(loginUrl(window.location.pathname))}
                className="px-6 py-2 bg-primary text-primary-foreground rounded-md font-medium hover:bg-primary/90 transition-colors"
              >
                使用 GitHub 登录
              </button>
            </div>
          )}

          {loadingComments ? (
            <div className="flex justify-center py-10">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : (
            <div className="space-y-6">
              {comments.map((comment) => (
                <div key={comment.id} className="bg-card p-5 rounded-xl border border-border flex space-x-4 group">
                  <img 
                    src={comment.author.avatarUrl} 
                    alt={comment.author.displayName} 
                    className="w-10 h-10 rounded-full border border-border flex-shrink-0"
                  />
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-2">
                      <div>
                        <span className="font-semibold text-foreground mr-3">{comment.author.displayName}</span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(comment.createdAt).toLocaleString('zh-CN')}
                        </span>
                      </div>
                      {/* Deleting is a write too, so it is paused with the rest of
                          them; see the notice above the list. */}
                    </div>
                    <p className="text-muted-foreground whitespace-pre-wrap leading-relaxed">
                      {comment.content}
                    </p>
                  </div>
                </div>
              ))}
              
              {comments.length === 0 && (
                <div className="text-center py-10 text-muted-foreground">
                  暂无评论，快来抢沙发吧！
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default ArticleDetail;
