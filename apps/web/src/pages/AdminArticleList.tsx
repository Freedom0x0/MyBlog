import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Edit, Plus, Send, Trash2 } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { deleteArticle, downloadBlogExport, listAdminArticles, updateArticle } from '../utils/articlesApi';
import { describeApiError } from '../lib/apiClient';
import ImportMarkdownPanel from '../components/ImportMarkdownPanel';
import type { AdminArticleSummary, ArticleStatus } from 'shared';

/**
 * `GET /api/v1/admin/articles` as a table — the only screen that can see drafts.
 *
 * Before this page existed, drafts could be created, updated and deleted but never
 * listed: the two admin routes were `/admin/articles/new` and
 * `/admin/articles/:slug/edit`, and the second one requires knowing the slug
 * (S3-R20~R22). So this page's job is exactly "the exit of the admin read
 * endpoints" — title, slug, status, last updated, plus 编辑 / 发布 / 删除 per row.
 * Deliberately absent: search, bulk row actions, sort switching, previews, status
 * tabs. The API accepts a `status` filter, and it is not used here because the
 * plan does not ask for it.
 *
 * One action is not about a row at all: 下载导出 (S8-a), sitting under the import
 * panel it pairs with. It is the only way anything on this screen can leave the
 * database, which since S3 is the only copy of the writing.
 *
 * Two data facts the UI has to respect:
 * - list rows carry **no `content`** (`AdminArticleSummary` = `ArticleAdmin` minus
 *   the body, and the repository's column list exists so it cannot widen by
 *   accident). No excerpt/preview is therefore possible without a second request
 *   per row, which is not done.
 * - immediately after a fresh seed every row's `updated_at` is **identical to the
 *   microsecond**, so the visible order comes from the `id` tie-breaker and looks
 *   arbitrary. That is the seed's shape, not a sorting bug — see the D0 execution
 *   notes in implement.md.
 */

const PAGE_LIMIT = 20;

const STATUS_LABELS: Record<ArticleStatus, string> = {
  draft: '草稿',
  published: '已发布',
  archived: '已归档',
};

/**
 * Status badge colours are listed rather than derived from the label text: the
 * three values are a closed set in the contract, and a rule like "green when the
 * label contains 发布" would mislabel `archived` the day wording changes.
 */
const STATUS_CLASSES: Record<ArticleStatus, string> = {
  draft: 'bg-amber-500/20 text-amber-600 border-amber-500/40',
  published: 'bg-green-500/20 text-green-600 border-green-500/40',
  archived: 'bg-muted text-muted-foreground border-border',
};

function StatusBadge({ status }: { status: string }) {
  /**
   * `AdminArticleSummary.status` is typed `string` in the contract (the write API
   * echoes whatever the row holds), so an unknown value is shown as-is rather than
   * crashed on or silently mapped to `draft`.
   */
  const known = status === 'draft' || status === 'published' || status === 'archived';
  const styled = known ? STATUS_CLASSES[status] : STATUS_CLASSES.archived;

  return (
    <span className={`inline-block px-2 py-0.5 text-xs rounded-full border ${styled}`}>
      {known ? STATUS_LABELS[status] : status}
    </span>
  );
}

type PendingAction = { slug: string; kind: 'publish' | 'delete' } | null;

export default function AdminArticleList() {
  const { isAdmin } = useAuthStore();

  const [rows, setRows] = useState<AdminArticleSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [exporting, setExporting] = useState(false);

  /**
   * Reload from page one.
   *
   * Used after an import (the batch just added rows) and after a delete that emptied
   * a page. Deliberately not a "patch the row in place" optimisation: `updateArticle`
   * answers with the server's row, and the list's order is keyed on `updated_at`, so
   * a row that was just published usually moves — re-reading is the honest answer.
   */
  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const page = await listAdminArticles({ limit: PAGE_LIMIT });
      setRows(page.data);
      setCursor(page.next?.cursor ?? null);
    } catch (error) {
      setRows([]);
      setCursor(null);
      setLoadError(describeApiError(error, '文章列表加载失败，请重试。'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    void reload();
  }, [isAdmin, reload]);

  const loadMore = async () => {
    if (cursor === null) return;
    setLoadingMore(true);
    setLoadError(null);
    try {
      /**
       * Keyset, not offset: the API's `next.cursor` is the full-precision
       * `(updated_at, id)` of the last row it returned, so appending pages neither
       * repeats nor skips rows when something else updates in between.
       */
      const page = await listAdminArticles({ limit: PAGE_LIMIT, cursor });
      setRows((current) => [...current, ...page.data]);
      setCursor(page.next?.cursor ?? null);
    } catch (error) {
      setLoadError(describeApiError(error, '下一页加载失败，请重试。'));
    } finally {
      setLoadingMore(false);
    }
  };

  /**
   * 发布 = `PATCH {status:'published'}` and nothing else.
   *
   * Same single-field patch the editor's 发布 button sends: content does not ride
   * along, because the list rows have no content to send (and a stale body pushed
   * from a list page would overwrite an edit made in the editor minutes ago).
   */
  const handlePublish = async (slug: string) => {
    setPending({ slug, kind: 'publish' });
    setActionError(null);
    setNotice(null);
    try {
      await updateArticle(slug, { status: 'published' });
      setNotice(`已发布：${slug}`);
      await reload();
    } catch (error) {
      setActionError(describeApiError(error, '发布失败，请重试。'));
    } finally {
      setPending(null);
    }
  };

  /**
   * 删除 is a hard delete — comments go with it by FK cascade and there is no
   * recycle bin (prd 已知限制 4) — hence the confirm before the request.
   */
  const handleDelete = async (row: AdminArticleSummary) => {
    if (!window.confirm(`确定删除《${row.title}》（${row.slug}）？这篇文章的评论会一并删除，且无法恢复。`)) {
      return;
    }

    setPending({ slug: row.slug, kind: 'delete' });
    setActionError(null);
    setNotice(null);
    try {
      await deleteArticle(row.slug);
      setNotice(`已删除：${row.slug}`);
      await reload();
    } catch (error) {
      setActionError(describeApiError(error, '删除失败，请重试。'));
    } finally {
      setPending(null);
    }
  };

  /**
   * 下载导出 = `GET /api/v1/admin/articles/export`, saved by the browser.
   *
   * One click, no confirm: it writes nothing, so there is nothing to undo — the
   * warning that belongs on this action is the one in the copy under the button
   * ("this is the only copy"), not a dialog. Failures go to the same `actionError`
   * band the row actions use, because a 401 here (session ended) has to read like the
   * rest of this page rather than like a browser error page.
   *
   * The list is not reloaded afterwards: an export cannot change a row, and a reload
   * would throw away the notice the person is still reading.
   */
  const handleExport = async () => {
    setExporting(true);
    setActionError(null);
    setNotice(null);
    try {
      const { files, bytes } = await downloadBlogExport();
      setNotice(`已导出 ${files} 篇文章（约 ${Math.round(bytes / 1024)} KiB），浏览器应已开始保存。`);
    } catch (error) {
      setActionError(describeApiError(error, '导出失败，请重试。'));
    } finally {
      setExporting(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center px-4">
        <div className="max-w-md w-full bg-card border border-border rounded-xl p-6 text-center">
          <div className="text-lg font-semibold mb-2">需要管理员权限</div>
          <div className="text-sm text-muted-foreground mb-4">请使用管理员账号登录后再访问。</div>
          <Link to="/" className="inline-flex px-4 py-2 bg-primary text-primary-foreground rounded-md">
            返回首页
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground px-4 py-10">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="text-2xl font-bold">文章管理</div>
            <div className="text-sm text-muted-foreground">
              草稿、已发布、已归档都在这里。按最后改动倒序；正文不在这个列表里，点「编辑」去看。
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link
              to="/admin/articles/new"
              className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90"
            >
              <Plus className="w-4 h-4" />
              新建文章
            </Link>
            <Link
              to="/"
              className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md text-sm"
            >
              返回站点
            </Link>
          </div>
        </div>

        {/* The import button lives on this page — it produces rows for this list, and
            the article detail page has no business creating articles. */}
        <ImportMarkdownPanel onImported={() => void reload()} />

        {/**
         * 下载导出 sits directly under the import panel because the two are one pair:
         * the file this button saves is the file that panel reads back, article for
         * article. The copy says what the export is *not* — comments and uploaded
         * images are not in it, and an import always lands a draft — because a backup
         * whose limits are unknown is a backup nobody trusts until the day it is needed.
         */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
          <div>
            <div className="text-sm font-medium">导出整站文章</div>
            <div className="text-xs text-muted-foreground">
              一个 JSON 文件，每篇文章都是导入所用的那份 Markdown（含 front-matter），
              草稿与已归档都在里面。<b>只含文章</b>：评论与已上传的图片不在其中。
              导回走上面的「导入 Markdown」，回来的每一篇都是草稿。
            </div>
          </div>
          <button
            onClick={() => void handleExport()}
            disabled={exporting}
            title="GET /api/v1/admin/articles/export — 读操作，不写任何东西"
            className="flex items-center gap-2 px-4 py-2 bg-secondary text-secondary-foreground rounded-md text-sm font-medium hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download className="w-4 h-4" />
            {exporting ? '导出中...' : '下载导出'}
          </button>
        </div>

        {loadError && (
          <div className="mb-4 text-sm px-4 py-2 rounded-md bg-red-500/10 text-red-600 border border-red-500/30">
            {loadError}
          </div>
        )}
        {actionError && (
          <div className="mb-4 text-sm px-4 py-2 rounded-md bg-red-500/10 text-red-600 border border-red-500/30">
            {actionError}
          </div>
        )}
        {notice && (
          <div className="mb-4 text-sm px-4 py-2 rounded-md bg-green-500/10 text-green-600 border border-green-500/30">
            {notice}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-10">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        ) : rows.length === 0 ? (
          /**
           * An empty table is the expected state right after the Supabase switch:
           * old content was deliberately not migrated (S3-R19), so "no articles yet"
           * is a fact about the decision, not a load failure. It says what to do
           * about it, because a blank page with no rows reads like a broken read.
           */
          <div className="bg-card border border-border rounded-xl p-10 text-center">
            <div className="text-lg font-semibold mb-2">还没有文章</div>
            <div className="text-sm text-muted-foreground mb-6 max-w-md mx-auto">
              旧内容按决定没有迁移过来，所以空是正常的。用上面的「导入 Markdown」把本地
              <code> .md</code> 变成草稿，或者去新建一篇再发布。
            </div>
            <div className="flex items-center justify-center gap-3">
              <Link
                to="/admin/articles/new"
                className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90"
              >
                新建文章
              </Link>
              <button
                onClick={() => void reload()}
                className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md text-sm"
              >
                重新加载
              </button>
            </div>
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-4 py-3">标题</th>
                  <th className="text-left font-medium px-4 py-3">Slug</th>
                  <th className="text-left font-medium px-4 py-3">状态</th>
                  <th className="text-left font-medium px-4 py-3">最后更新</th>
                  <th className="text-right font-medium px-4 py-3">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.slug} className="border-t border-border">
                    <td className="px-4 py-3">
                      <Link to={`/blog/${row.slug}`} className="hover:text-primary">
                        {row.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <code className="text-xs text-muted-foreground">{row.slug}</code>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                      {new Date(row.updatedAt).toLocaleString('zh-CN')}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <Link
                          to={`/admin/articles/${encodeURIComponent(row.slug)}/edit`}
                          className="flex items-center gap-1 px-3 py-1.5 bg-secondary text-secondary-foreground rounded-md hover:bg-accent"
                        >
                          <Edit className="w-3.5 h-3.5" />
                          编辑
                        </Link>
                        <button
                          onClick={() => void handlePublish(row.slug)}
                          disabled={row.status === 'published' || pending !== null}
                          title={
                            row.status === 'published'
                              ? '这篇已经是发布状态'
                              : '只发一个 status 的 PATCH，不动正文'
                          }
                          className="flex items-center gap-1 px-3 py-1.5 bg-green-600 text-white rounded-md disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Send className="w-3.5 h-3.5" />
                          {pending?.slug === row.slug && pending.kind === 'publish' ? '发布中...' : '发布'}
                        </button>
                        <button
                          onClick={() => void handleDelete(row)}
                          disabled={pending !== null}
                          title="硬删除，评论一并级联删掉，没有回收站"
                          className="flex items-center gap-1 px-3 py-1.5 bg-red-500/20 text-red-600 rounded-md hover:bg-red-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          {pending?.slug === row.slug && pending.kind === 'delete' ? '删除中...' : '删除'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="px-4 py-3 border-t border-border flex items-center justify-between text-sm text-muted-foreground">
              <span>已显示 {rows.length} 篇。</span>
              {cursor !== null ? (
                <button
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md hover:bg-accent disabled:opacity-50"
                >
                  {loadingMore ? '加载中...' : '加载更多'}
                </button>
              ) : (
                <span>已经是最后一页。</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
