import React, { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { ArrowLeft, Clock, Calendar, Tag, Edit, Save, X, MessageSquare, Trash2 } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import MDEditor from '@uiw/react-md-editor';
import rehypeSanitize from 'rehype-sanitize';
import { getAdminArticle, getArticleBySlug, updateArticle } from '../utils/articlesApi';
import { deleteComment, listComments, postComment } from '../utils/commentsApi';
import { loginUrl } from '../utils/authApi';
import { describeApiError, ApiError } from '../lib/apiClient';
import type { ArticleDetail as PublicArticle, ArticleAdmin, CommentAuthor, CommentNode } from 'shared';

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

/**
 * The API answers comments **flat with a `parentId` pointer** and leaves the tree
 * to the client (`CommentNode` in `packages/shared` says so; the read path stays a
 * single indexed query instead of a recursive CTE per page view). Rendering the
 * array in that order — which is what this page used to do — displays a reply as a
 * top-level comment, visibly wrong on the seeded article, whose second comment
 * replies to the first.
 */
interface CommentTree {
  roots: CommentNode[];
  childrenOf: Map<string, CommentNode[]>;
}

function buildCommentTree(flat: CommentNode[]): CommentTree {
  const byId = new Map<string, CommentNode>();
  for (const node of flat) byId.set(node.id, node);

  const childrenOf = new Map<string, CommentNode[]>();
  const roots: CommentNode[] = [];

  for (const node of flat) {
    const parent = node.parentId === null ? undefined : byId.get(node.parentId);

    // No parent *in this page's data* means top-level — including the case where
    // the parent is gone (deleted server-side after this list was read), which is
    // shown as an orphaned root rather than hidden along with its thread.
    if (parent === undefined) {
      roots.push(node);
      continue;
    }

    const siblings = childrenOf.get(parent.id);
    if (siblings === undefined) childrenOf.set(parent.id, [node]);
    else siblings.push(node);
  }

  // Chronological within every level, whatever order the API happened to return.
  const byCreatedAt = (a: CommentNode, b: CommentNode) => a.createdAt.localeCompare(b.createdAt);
  roots.sort(byCreatedAt);
  for (const list of childrenOf.values()) list.sort(byCreatedAt);

  return { roots, childrenOf };
}

/**
 * The ids of a comment and everything under it.
 *
 * Deleting a parent cascades to its replies server-side, so a successful delete has
 * to remove the whole subtree from what is on screen — leaving a reply visible under
 * a parent that no longer exists would be a lie until the next reload.
 */
function collectSubtreeIds(rootId: string, childrenOf: Map<string, CommentNode[]>): Set<string> {
  const ids = new Set<string>();
  const visit = (id: string) => {
    ids.add(id);
    for (const child of childrenOf.get(id) ?? []) {
      // Guard against revisiting: only reachable if the data ever loops, but the
      // walk is cheap to make safe and a stack overflow here would blank the page.
      if (!ids.has(child.id)) visit(child.id);
    }
  };
  visit(rootId);
  return ids;
}

/** `avatarUrl` is nullable in the contract, so an avatar is only one render path. */
function AuthorAvatar({ author }: { author: CommentAuthor }) {
  // `||` rather than `??`: `displayName` is nullable and a seeded author can carry
  // an empty string, which would otherwise render an empty circle.
  const label = author.displayName || author.login || '?';
  const initial = label.slice(0, 1).toUpperCase();

  if (author.avatarUrl === null || author.avatarUrl === '') {
    return (
      <div className="w-10 h-10 rounded-full border border-border bg-muted flex items-center justify-center text-sm font-semibold text-muted-foreground flex-shrink-0">
        {initial}
      </div>
    );
  }

  return (
    <img
      src={author.avatarUrl}
      alt={label}
      className="w-10 h-10 rounded-full border border-border flex-shrink-0"
    />
  );
}

interface CommentItemProps {
  node: CommentNode;
  depth: number;
  tree: CommentTree;
  canModerate: (comment: CommentNode) => boolean;
  canReply: boolean;
  replyingTo: string | null;
  deletingId: string | null;
  onReply: (comment: CommentNode) => void;
  onCancelReply: () => void;
  onDelete: (comment: CommentNode) => void;
}

/**
 * One comment plus its replies, recursively.
 *
 * Depth is not capped at two: the flat contract allows arbitrary nesting and only
 * the seed data happens to be one level deep, so the renderer follows the pointer
 * structure instead of special-casing "a parent and its children".
 */
function CommentItem({
  node,
  depth,
  tree,
  canModerate,
  canReply,
  replyingTo,
  deletingId,
  onReply,
  onCancelReply,
  onDelete,
}: CommentItemProps) {
  const children = tree.childrenOf.get(node.id) ?? [];
  const isReplyTarget = replyingTo === node.id;

  return (
    <div className={depth === 0 ? '' : 'mt-4 ml-6 md:ml-10'}>
      <div
        className={`bg-card p-5 rounded-xl border flex space-x-4 group ${
          isReplyTarget ? 'border-primary/60' : 'border-border'
        }`}
      >
        <AuthorAvatar author={node.author} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-2 gap-2">
            <div className="min-w-0">
              <span className="font-semibold text-foreground mr-3">{node.author.displayName || node.author.login}</span>
              <span className="text-xs text-muted-foreground">
                {new Date(node.createdAt).toLocaleString('zh-CN')}
              </span>
            </div>
            <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
              {canReply && (
                /**
                 * No reply affordance without a session: the form it opens lives in
                 * the signed-in branch above, so a link that only set state would be
                 * a control with no visible effect. `POST .../comments` answers 401
                 * either way — hiding it is layout, not permission.
                 */
                <button
                  onClick={() => (isReplyTarget ? onCancelReply() : onReply(node))}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {isReplyTarget ? '取消回复' : '回复'}
                </button>
              )}
              {canModerate(node) && (
                /**
                 * Hidden for anyone who is not the author or an admin, and that is
                 * presentation only: `DELETE /comments/:id` answers 403 for everyone
                 * else server-side (design §2), which is the actual control.
                 */
                <button
                  onClick={() => onDelete(node)}
                  disabled={deletingId === node.id}
                  className="flex items-center gap-1 text-xs text-red-600 hover:text-red-500 transition-colors disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {deletingId === node.id ? '删除中...' : '删除'}
                </button>
              )}
            </div>
          </div>
          <p className="text-muted-foreground whitespace-pre-wrap leading-relaxed">{node.content}</p>
        </div>
      </div>

      {children.map((child) => (
        <CommentItem
          key={child.id}
          node={child}
          depth={depth + 1}
          tree={tree}
          canModerate={canModerate}
          canReply={canReply}
          replyingTo={replyingTo}
          deletingId={deletingId}
          onReply={onReply}
          onCancelReply={onCancelReply}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}


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
  const [commentDraft, setCommentDraft] = useState('');
  /** The comment being replied to, or null while writing a top-level comment. */
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [postingComment, setPostingComment] = useState(false);
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null);
  const [commentError, setCommentError] = useState<string | null>(null);

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
        // The reply target belonged to the thread that was just replaced.
        setReplyingTo(null);
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

  const tree = useMemo(() => buildCommentTree(comments), [comments]);

  /** Looked up by id only for the "正在回复 @x" line; `undefined` after a delete. */
  const replyTarget =
    replyingTo === null ? undefined : comments.find((comment) => comment.id === replyingTo);

  /**
   * Who may delete a comment, as a *display* rule.
   *
   * Identity is compared on `author.id`, never on a login or display name: `login`
   * is a field the person can change, and defect D1 in this repository was exactly
   * a browser-side username comparison. The matching rule the API enforces is the
   * same one (author or admin) — see design §2 — and the button being hidden is not
   * what makes deletion safe.
   */
  const canModerateComment = (comment: CommentNode): boolean =>
    isAdmin || (user !== null && comment.author.id === user.id);

  /**
   * 发表 / 回复 both go through `POST /articles/:slug/comments`; the only difference
   * is whether the body names a `parentId`. The server derives the author from the
   * session token, so nothing identifying the commenter is sent.
   */
  const handleSubmitComment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!slug) return;

    const content = commentDraft.trim();
    // Empty is refused locally because the API would answer 400 `BAD_REQUEST` for
    // a request that carries no intent at all. Length (max 4000) is *not* guessed
    // at here: the byte-vs-character gap belongs to the server's message, not to a
    // second rule in this file.
    if (content === '') return;

    setPostingComment(true);
    setCommentError(null);

    try {
      const created = await postComment(slug, {
        content,
        ...(replyingTo === null ? {} : { parentId: replyingTo }),
      });
      // The server's node (its id, its timestamp, its joined author) is appended
      // rather than a locally assembled stand-in.
      setComments((current) => [...current, created]);
      setCommentDraft('');
      setReplyingTo(null);
    } catch (error) {
      /**
       * 400 `INVALID_COMMENT_PARENT` (the reply target is not on this article any
       * more), 400 `BAD_REQUEST` (empty or over 4000 characters) and 401 all land
       * here with the API's own message, and the draft stays on screen so the text
       * survives the fix-and-retry. Nothing is appended optimistically.
       */
      setCommentError(describeApiError(error, '评论发送失败，请重试。'));
    } finally {
      setPostingComment(false);
    }
  };

  /**
   * Deleting is the same `DELETE /comments/:id` for author and admin; 403/404 come
   * back from the API and are shown rather than predicted.
   */
  const handleDeleteComment = async (target: CommentNode) => {
    const subtree = collectSubtreeIds(target.id, tree.childrenOf);
    const childCount = subtree.size - 1;

    if (
      !window.confirm(
        childCount > 0
          ? `删除这条评论？它下面的 ${childCount} 条回复也会一并删除，且无法恢复。`
          : '删除这条评论？此操作无法恢复。',
      )
    ) {
      return;
    }

    setDeletingCommentId(target.id);
    setCommentError(null);

    try {
      await deleteComment(target.id);
      // Removed locally instead of re-fetching the whole thread: the answer is
      // already known (this subtree is gone), and a reload would throw away the
      // draft sitting in the box above.
      setComments((current) => current.filter((comment) => !subtree.has(comment.id)));
      if (replyingTo !== null && subtree.has(replyingTo)) setReplyingTo(null);
    } catch (error) {
      // 403 (not the author, not an admin) / 404 (already gone) — the list is left
      // untouched, because a failed delete means the comment is still there.
      setCommentError(describeApiError(error, '评论删除失败，请重试。'));
    } finally {
      setDeletingCommentId(null);
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
             * S2's "评论与发表暂时只读" notice is gone, and this form is what replaced it
             * (S3-R17): the endpoints and `utils/commentsApi` calls have existed since
             * D-1, the screen just never offered a way to use them.
             */
            <form onSubmit={handleSubmitComment} className="mb-10 bg-card p-4 rounded-xl border border-border">
              {replyingTo !== null && (
                <div className="flex items-center justify-between mb-2 text-xs text-muted-foreground">
                  {/* Named from the thread itself, so the person can see which
                      comment this reply is about to be attached to — the id is what
                      the server validates, but a uuid is not a useful label. */}
                  <span>
                    正在回复 {replyTarget ? replyTarget.author.displayName ?? replyTarget.author.login : '一条评论'}。
                  </span>
                  <button
                    type="button"
                    onClick={() => setReplyingTo(null)}
                    className="hover:text-foreground transition-colors"
                  >
                    取消回复
                  </button>
                </div>
              )}
              <textarea
                value={commentDraft}
                onChange={(event) => setCommentDraft(event.target.value)}
                rows={3}
                placeholder={replyingTo === null ? '写下你的评论…' : '写下你的回复…'}
                className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm"
              />
              <div className="flex items-center justify-end mt-3 gap-3">
                <button
                  type="submit"
                  disabled={postingComment || commentDraft.trim() === ''}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {postingComment ? '发送中...' : replyingTo === null ? '发表评论' : '发送回复'}
                </button>
              </div>
            </form>
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

          {commentError && (
            <div className="mb-6 text-sm px-4 py-3 rounded-md bg-red-500/10 text-red-600 border border-red-500/30">
              {commentError}
              <div className="mt-1 text-xs opacity-80">
                这条失败说的是服务器对这次请求的回答，输入框里的内容还在，改好可以直接再发一次。
              </div>
            </div>
          )}

          {loadingComments ? (
            <div className="flex justify-center py-10">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : (
            <div className="space-y-6">
              {tree.roots.map((comment) => (
                <CommentItem
                  key={comment.id}
                  node={comment}
                  depth={0}
                  tree={tree}
                  canModerate={canModerateComment}
                  canReply={user !== null}
                  replyingTo={replyingTo}
                  deletingId={deletingCommentId}
                  onReply={(target) => {
                    setReplyingTo(target.id);
                    setCommentError(null);
                  }}
                  onCancelReply={() => setReplyingTo(null)}
                  onDelete={(target) => void handleDeleteComment(target)}
                />
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
