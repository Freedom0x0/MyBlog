import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { importArticles, updateArticle } from '../utils/articlesApi';
import { describeApiError } from '../lib/apiClient';
import type {
  ImportArticleConflictResult,
  ImportArticleCreatedResult,
  ImportArticleFile,
  ImportArticleResult,
} from 'shared';

/**
 * "导入 Markdown" — pick local `.md` files, send their raw text to the API, show
 * one line per file.
 *
 * Three rules shape this panel, and all three come from the server's contract:
 *
 * 1. Parsing is server-side (design §3), so the browser never looks at
 *    front-matter. A conflicting row therefore cannot be overwritten from data the
 *    browser holds — which is why the server returns the parsed draft alongside the
 *    conflict as `proposed` (design §3.3). 覆盖 sends *that* object to
 *    `PATCH /articles/:slug`: one parser, one write path, and the decision stays a
 *    per-row click rather than a batch checkbox. It carries no `status`, so
 *    overwriting a published article replaces its text without un-publishing it and
 *    never publishes a draft on the side.
 * 2. Any file that fails to *parse* answers 400 and writes nothing (S3-R11), so
 *    the batch either all reaches the write stage or none does. A failure that
 *    comes back per-file (`kind: 'conflict'`) is inside an otherwise 200
 *    response, so it must never be rendered as "导入失败".
 * 3. Imported rows are always drafts (S3-R9), even when the file's front-matter
 *    says `status: published`. The closing line points at the list below rather
 *    than offering an "import and publish" shortcut — publishing stays a separate
 *    human action, which is the whole point of that rule.
 */

/**
 * Local pre-checks, deliberately a *warning* rather than a gate.
 *
 * The API owns the limits (20 files, 128 KiB per file, 2 MiB per batch — see
 * `apps/api/src/modules/articles/schema.ts`), and copying those numbers here to
 * block a submission would put the same rule in two places where they can drift.
 * What this does that the server cannot do well is answer *before* a several-megabyte
 * upload: "you picked 40 files, that one is 3 MB". The request still goes out if
 * the person proceeds, and the server's message wins — it is the only judge.
 */
const MAX_FILES_HINT = 20;
const MAX_FILE_BYTES_HINT = 128 * 1024;
const MAX_BATCH_BYTES_HINT = 2 * 1024 * 1024;

function formatKiB(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

interface OversizedFile {
  name: string;
  size: number;
}

interface LocalHint {
  fileCount: string | null;
  oversized: OversizedFile[];
}

function inspectLocal(files: ImportArticleFile[]): LocalHint {
  return {
    fileCount:
      files.length > MAX_FILES_HINT
        ? `${files.length} 份（一次最多 ${MAX_FILES_HINT} 份）`
        : null,
    oversized: files
      .filter((file) => file.markdown.length > MAX_FILE_BYTES_HINT)
      .map((file) => ({ name: file.name, size: file.markdown.length })),
  };
}

export default function ImportMarkdownPanel({ onImported }: { onImported: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ImportArticleResult[] | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  /**
   * Per-conflict-row overwrite state, keyed by slug: a batch can carry several
   * conflicts, and one row failing must not make the others look like successes.
   * A string value is the message to show for that row.
   */
  const [overwritten, setOverwritten] = useState<Record<string, 'busy' | 'done' | string>>({});

  const handleOverwrite = async (result: ImportArticleConflictResult) => {
    if (
      !window.confirm(
        `用「${result.name}」的内容覆盖已存在的那篇（${result.slug}）？它现在的正文会被替换，这一步无法撤销。`,
      )
    ) {
      return;
    }

    setOverwritten((current) => ({ ...current, [result.slug]: 'busy' }));
    try {
      /**
       * `proposed` is the server's own parse of this file, handed back for exactly
       * this call (design §3.3). It carries no `status`, so overwriting replaces the
       * text and leaves whatever state the row was in — a published article stays
       * published, a draft stays a draft.
       */
      await updateArticle(result.slug, result.proposed);
      setOverwritten((current) => ({ ...current, [result.slug]: 'done' }));
      onImported();
    } catch (caught) {
      setOverwritten((current) => ({
        ...current,
        [result.slug]: describeApiError(caught, '覆盖失败，请重试。'),
      }));
    }
  };

  const handlePick = async (picked: FileList | null) => {
    if (!picked || picked.length === 0) return;
    setError(null);
    setHint(null);

    const chosen = Array.from(picked);
    setBusy(true);

    /**
     * `File.text()` reads the bytes as UTF-8 text; `name` is the basename the
     * browser offers, used by the API only to point at a file in a message.
     * No path is ever taken from it, and it never reaches SQL (see
     * `ImportArticleFile.name` in `shared`).
     */
    try {
      const payload: ImportArticleFile[] = await Promise.all(
        chosen.map(async (file) => ({ name: file.name, markdown: await file.text() })),
      );

      const local = inspectLocal(payload);
      const warnings: string[] = local.fileCount ? [local.fileCount] : [];
      /**
       * `markdown.length` counts UTF-16 *characters*; the server bounds UTF-8
       * *bytes* (`IMPORT_MAX_MARKDOWN_BYTES` in `apps/api/src/modules/articles/schema.ts`).
       * A character is never fewer than one byte, so anything flagged here is
       * genuinely over the limit — the warning can be a false negative on CJK text
       * (the server then answers 400 and says so), but it cannot fire on a batch the
       * server would have accepted, which is why the message below can promise the
       * rejection. That asymmetry is also why this is a heads-up and not a gate:
       * copying the rule to block submissions would put it in two places.
       */
      for (const over of local.oversized) {
        warnings.push(
          `「${over.name}」正文约 ${formatKiB(over.size)}，单篇上限 ${formatKiB(MAX_FILE_BYTES_HINT)}`,
        );
      }
      const total = payload.reduce((sum, file) => sum + file.markdown.length, 0);
      if (total > MAX_BATCH_BYTES_HINT) {
        warnings.push(
          `这一批正文合计约 ${formatKiB(total)}，整批上限 ${formatKiB(MAX_BATCH_BYTES_HINT)}`,
        );
      }

      setHint(
        warnings.length > 0
          ? `服务器会拒掉这一批，仍然发了过去让它给出确切原因：\n${warnings.join('\n')}`
          : null,
      );

      const response = await importArticles(payload);
      setResults(response.results);
      // Whatever landed is a draft, so the list underneath is stale by definition.
      onImported();
    } catch (caught) {
      /**
       * 400 here means "one of these files is not valid front-matter, and nothing
       * was written"; 413 means the request body itself was refused. Either way
       * the API's own message names the file, so it is shown verbatim rather than
       * paraphrased — a paraphrase would go stale when the backend's wording
       * changes, and this is the same `describeApiError` the editor and the detail
       * page already use.
       */
      setError(describeApiError(caught, '导入失败，请重试。'));
      setResults(null);
    } finally {
      setBusy(false);
      // So picking the same file a second time still fires `change`.
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  /**
   * Split by the discriminant, with the predicate written out: `typescript ~5.0`
   * does not infer one from `filter`, so without the annotation `created` would
   * stay `ImportArticleResult[]` and `result.article` would not typecheck.
   */
  const created = (results ?? []).filter(
    (result): result is ImportArticleCreatedResult => result.kind === 'created',
  );
  const conflicts = (results ?? []).filter(
    (result): result is ImportArticleConflictResult => result.kind === 'conflict',
  );

  return (
    <div className="mb-6 bg-card border border-border rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">导入 Markdown</div>
          <div className="text-xs text-muted-foreground">
            选择一个或多个本地 <code>.md</code> 文件。原文会交给服务器解析（浏览器不解析
            front-matter），导入后一律是<b>草稿</b>——发布要在下面的列表里另外点一次。
          </div>
        </div>
        <div className="flex items-center gap-3">
          <input
            ref={inputRef}
            type="file"
            accept=".md"
            multiple
            className="hidden"
            onChange={(event) => void handlePick(event.target.files)}
          />
          <button
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Upload className="w-4 h-4" />
            {busy ? '导入中...' : '选择 .md 文件'}
          </button>
        </div>
      </div>

      {hint && (
        <div className="mt-3 text-xs px-3 py-2 rounded-md bg-amber-500/10 text-amber-600 border border-amber-500/30 whitespace-pre-line">
          {hint}
        </div>
      )}

      {error && (
        <div className="mt-3 text-sm px-3 py-2 rounded-md bg-red-500/10 text-red-600 border border-red-500/30">
          {error}
          <div className="mt-1 text-xs opacity-80">
            整批 front-matter 解析失败时服务器一篇都不写；重导同一批是安全的补救。
          </div>
        </div>
      )}

      {results && (
        <div className="mt-4 space-y-4">
          {created.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-green-600 mb-2">
                已创建草稿（{created.length}）
              </div>
              <ul className="space-y-1">
                {created.map((result) => (
                  <li key={`${result.name}:${result.article.slug}`} className="text-sm text-muted-foreground">
                    {result.name} →{' '}
                    <span className="text-foreground">{result.article.title}</span>
                    <span className="ml-2 text-xs">
                      （slug <code>{result.article.slug}</code>，状态 {result.article.status === 'draft' ? '草稿' : result.article.status}）
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {conflicts.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-amber-600 mb-2">
                已存在，未改动（{conflicts.length}）
              </div>
              <ul className="space-y-2">
                {conflicts.map((result) => {
                  const state = overwritten[result.slug];
                  return (
                    <li key={`${result.name}:${result.slug}`} className="text-sm text-muted-foreground">
                      <div>
                        {result.name} → 这篇已存在：<code>{result.slug}</code>
                        <span className="ml-2 text-xs">（{result.message}）</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
                        {state === 'done' ? (
                          <span className="text-green-600">已用这份文件覆盖。</span>
                        ) : (
                          <button
                            onClick={() => void handleOverwrite(result)}
                            disabled={state === 'busy'}
                            className="px-3 py-1 bg-secondary text-secondary-foreground rounded-md font-medium hover:bg-secondary/80 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {state === 'busy' ? '覆盖中...' : '用这份文件覆盖'}
                          </button>
                        )}
                        {typeof state === 'string' && <span className="text-red-600">{state}</span>}
                        <span>
                          覆盖只替换正文与字段，<b>不改发布状态</b>；也可以去下面的列表里{' '}
                          <a href={`/admin/articles/${encodeURIComponent(result.slug)}/edit`} className="text-primary underline">
                            编辑
                          </a>{' '}
                          那篇。
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {conflicts.length === 0 && created.length > 0 && (
            <div className="text-sm text-green-600">
              本批 {created.length} 篇已全部成为草稿，在下面的列表里逐篇发布。
            </div>
          )}
        </div>
      )}
    </div>
  );
}
