'use client'

import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { MessageSquare, Trash2 } from 'lucide-react'
import type { CommentAuthor, CommentNode } from 'shared'
import { deleteComment, describeApiError, listComments, loginUrl, postComment } from '@/lib/client-api'
import { useSession } from '@/components/session-provider'

/**
 * `ArticleDetail.tsx`'s comment section, ported.
 *
 * Client-fetched on purpose (design D-5 / S4-R7): comments are per-visitor — the
 * delete affordance depends on who is looking — and posting is login-gated, so putting
 * them in the page cache would either leak one visitor's view to another or force the
 * cache to be thrown away per request. The article body above is server-rendered; this
 * section below is not, and the page's HTML is complete without it.
 *
 * `loading` is a real state here (a browser request genuinely is in flight), and it is
 * separate from "empty": the spinner must not be the thing a comment-free article shows
 * forever, which is the S3 defect this whole distinction came from.
 */

/**
 * The API answers comments **flat with a `parentId` pointer** and leaves the tree to
 * the client. Rendering the array in that order displays a reply as a top-level
 * comment, visibly wrong on the seeded article, whose second comment replies to the
 * first.
 */
interface CommentTree {
  roots: CommentNode[]
  childrenOf: Map<string, CommentNode[]>
}

function buildCommentTree(flat: CommentNode[]): CommentTree {
  const byId = new Map<string, CommentNode>()
  for (const node of flat) byId.set(node.id, node)

  const childrenOf = new Map<string, CommentNode[]>()
  const roots: CommentNode[] = []

  for (const node of flat) {
    const parent = node.parentId === null ? undefined : byId.get(node.parentId)

    // No parent *in this page's data* means top-level — including the case where the
    // parent is gone (deleted server-side after this list was read), which is shown as
    // an orphaned root rather than hidden along with its thread.
    if (parent === undefined) {
      roots.push(node)
      continue
    }

    const siblings = childrenOf.get(parent.id)
    if (siblings === undefined) childrenOf.set(parent.id, [node])
    else siblings.push(node)
  }

  // Chronological within every level, whatever order the API happened to return.
  const byCreatedAt = (a: CommentNode, b: CommentNode) => a.createdAt.localeCompare(b.createdAt)
  roots.sort(byCreatedAt)
  for (const list of childrenOf.values()) list.sort(byCreatedAt)

  return { roots, childrenOf }
}

/**
 * The ids of a comment and everything under it.
 *
 * Deleting a parent cascades to its replies server-side, so a successful delete has to
 * remove the whole subtree from what is on screen.
 */
function collectSubtreeIds(rootId: string, childrenOf: Map<string, CommentNode[]>): Set<string> {
  const ids = new Set<string>()
  const visit = (id: string) => {
    ids.add(id)
    for (const child of childrenOf.get(id) ?? []) {
      if (!ids.has(child.id)) visit(child.id)
    }
  }
  visit(rootId)
  return ids
}

/** `avatarUrl` is nullable in the contract, so an avatar is only one render path. */
function AuthorAvatar({ author }: { author: CommentAuthor }) {
  // `||` rather than `??`: `displayName` is nullable and a seeded author can carry
  // an empty string, which would otherwise render an empty circle.
  const label = author.displayName || author.login || '?'
  const initial = label.slice(0, 1).toUpperCase()

  if (author.avatarUrl === null || author.avatarUrl === '') {
    return (
      <div className="w-10 h-10 rounded-full border border-border bg-muted flex items-center justify-center text-sm font-semibold text-muted-foreground flex-shrink-0">
        {initial}
      </div>
    )
  }

  return (
    <img
      src={author.avatarUrl}
      alt={label}
      className="w-10 h-10 rounded-full border border-border flex-shrink-0"
    />
  )
}

interface CommentItemProps {
  node: CommentNode
  depth: number
  tree: CommentTree
  canModerate: (comment: CommentNode) => boolean
  canReply: boolean
  replyingTo: string | null
  deletingId: string | null
  onReply: (comment: CommentNode) => void
  onCancelReply: () => void
  onDelete: (comment: CommentNode) => void
}

/**
 * One comment plus its replies, recursively. Depth is not capped at two: the flat
 * contract allows arbitrary nesting and only the seed data happens to be one level
 * deep.
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
  const children = tree.childrenOf.get(node.id) ?? []
  const isReplyTarget = replyingTo === node.id

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
              <span className="font-semibold text-foreground mr-3">
                {node.author.displayName || node.author.login}
              </span>
              <span className="text-xs text-muted-foreground">
                {new Date(node.createdAt).toLocaleString('zh-CN')}
              </span>
            </div>
            <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
              {canReply && (
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
                 * else server-side, which is the actual control.
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
  )
}

export default function CommentsSection({ slug }: { slug: string }) {
  const { user, isAdmin } = useSession()
  const [comments, setComments] = useState<CommentNode[]>([])
  const [loadingComments, setLoadingComments] = useState(true)
  const [commentDraft, setCommentDraft] = useState('')
  /** The comment being replied to, or null while writing a top-level comment. */
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [postingComment, setPostingComment] = useState(false)
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null)
  const [commentError, setCommentError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const fetchComments = async () => {
      setLoadingComments(true)
      try {
        const data = await listComments(slug)
        if (cancelled) return
        setComments(data)
        // The reply target belonged to the thread that was just replaced.
        setReplyingTo(null)
      } catch (error) {
        // A failed comment read must not take the article page down: the article has
        // already rendered, so degrade this panel instead of blanking it.
        console.error('comments load failed', error)
        if (!cancelled) setComments([])
      } finally {
        if (!cancelled) setLoadingComments(false)
      }
    }

    void fetchComments()
    return () => {
      cancelled = true
    }
  }, [slug])

  const tree = useMemo(() => buildCommentTree(comments), [comments])

  /** Looked up by id only for the "正在回复 @x" line. */
  const replyTarget =
    replyingTo === null ? undefined : comments.find((comment) => comment.id === replyingTo)

  /**
   * Who may delete a comment, as a *display* rule.
   *
   * Identity is compared on `author.id`, never on a login or display name: `login` is
   * a field the person can change. The rule the API enforces is the same one (author
   * or admin) and the button being hidden is not what makes deletion safe.
   */
  const canModerateComment = (comment: CommentNode): boolean =>
    isAdmin || (user !== null && comment.author.id === user.id)

  /**
   * 发表 / 回复 both go through `POST /articles/:slug/comments`; the only difference is
   * whether the body names a `parentId`. The server derives the author from the session
   * token, so nothing identifying the commenter is sent.
   */
  const handleSubmitComment = async (event: FormEvent) => {
    event.preventDefault()

    const content = commentDraft.trim()
    // Empty is refused locally because the API would answer 400 `BAD_REQUEST` for a
    // request that carries no intent at all. Length (max 4000) is *not* guessed at
    // here: the byte-vs-character gap belongs to the server's message.
    if (content === '') return

    setPostingComment(true)
    setCommentError(null)

    try {
      const created = await postComment(slug, {
        content,
        ...(replyingTo === null ? {} : { parentId: replyingTo }),
      })
      // The server's node (its id, its timestamp, its joined author) is appended
      // rather than a locally assembled stand-in.
      setComments((current) => [...current, created])
      setCommentDraft('')
      setReplyingTo(null)
    } catch (error) {
      // 400 `INVALID_COMMENT_PARENT` / 400 `BAD_REQUEST` / 401 all land here with the
      // API's own message, and the draft stays on screen.
      setCommentError(describeApiError(error, '评论发送失败，请重试。'))
    } finally {
      setPostingComment(false)
    }
  }

  const handleDeleteComment = async (target: CommentNode) => {
    const subtree = collectSubtreeIds(target.id, tree.childrenOf)
    const childCount = subtree.size - 1

    if (
      !window.confirm(
        childCount > 0
          ? `删除这条评论？它下面的 ${childCount} 条回复也会一并删除，且无法恢复。`
          : '删除这条评论？此操作无法恢复。',
      )
    ) {
      return
    }

    setDeletingCommentId(target.id)
    setCommentError(null)

    try {
      await deleteComment(target.id)
      // Removed locally instead of re-fetching the whole thread: the answer is already
      // known (this subtree is gone), and a reload would throw away the draft sitting
      // in the box above.
      setComments((current) => current.filter((comment) => !subtree.has(comment.id)))
      if (replyingTo !== null && subtree.has(replyingTo)) setReplyingTo(null)
    } catch (error) {
      // 403 / 404 come back from the API and are shown rather than predicted.
      setCommentError(describeApiError(error, '评论删除失败，请重试。'))
    } finally {
      setDeletingCommentId(null)
    }
  }

  return (
    <div className="mt-16">
      <h3 className="text-2xl font-bold mb-8 flex items-center">
        <MessageSquare className="w-6 h-6 mr-3 text-primary" />
        评论 ({comments.length})
      </h3>

      {user ? (
        <form onSubmit={handleSubmitComment} className="mb-10 bg-card p-4 rounded-xl border border-border">
          {replyingTo !== null && (
            <div className="flex items-center justify-between mb-2 text-xs text-muted-foreground">
              <span>
                正在回复{' '}
                {replyTarget ? replyTarget.author.displayName ?? replyTarget.author.login : '一条评论'}。
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
          {/* A plain anchor, not `next/link`: the SPA used `window.location.assign`,
              and this URL leaves the React app for the provider. `Link` would
              *prefetch* it, i.e. send a second GET to `/auth/github/start`, and an
              OAuth start is not an idempotent hop to make twice. */}
          <a
            href={loginUrl(`/blog/${slug}`)}
            className="inline-block px-6 py-2 bg-primary text-primary-foreground rounded-md font-medium hover:bg-primary/90 transition-colors"
          >
            使用 GitHub 登录
          </a>
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
                setReplyingTo(target.id)
                setCommentError(null)
              }}
              onCancelReply={() => setReplyingTo(null)}
              onDelete={(target) => void handleDeleteComment(target)}
            />
          ))}

          {comments.length === 0 && (
            <div className="text-center py-10 text-muted-foreground">暂无评论，快来抢沙发吧！</div>
          )}
        </div>
      )}
    </div>
  )
}
