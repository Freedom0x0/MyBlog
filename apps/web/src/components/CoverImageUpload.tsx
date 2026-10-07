import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import {
  ALLOWED_UPLOAD_CONTENT_TYPES,
  MAX_UPLOAD_BYTES_HINT,
  completeUpload,
  isAllowedContentType,
  requestUpload,
} from '../utils/uploadsApi';
import { ApiError, describeApiError, putPresignedObject } from '../lib/apiClient';
/**
 * `ERROR_CODES` is a runtime value, so this is the one non-type import from `shared`
 * in `apps/web`. Worth the exception: `describeFailure` branches on whether the server
 * *refused the media* (which is what makes "nothing to clean up" true), and spelling
 * those two codes out as string literals here would put the contract's vocabulary in a
 * second place where it can drift.
 */
import { ERROR_CODES, type CompletedUpload } from 'shared';

/**
 * "上传" for the cover image: pick a local picture, and the field ends up holding a
 * URL served from our own bucket.
 *
 * The manual URL input above this component stays exactly as it was, and that is not
 * laziness: `cover_image` only ever lands in `<img src>`, so a typed URL is not an
 * execution point, and removing manual entry would make an article whose cover was set
 * before this feature uneditable. What changes is that a picture no longer has to
 * already live somewhere else.
 *
 * The flow is the server's three steps, in order, with nothing merged:
 * ask for a signature → PUT the bytes to the object store → ask the server what it
 * measured. The middle step is `putPresignedObject`, *not* the portal client, and the
 * reason is written out there: MinIO is a different origin, the session means nothing
 * to it, and the only header this call sends is the media type the object keeps.
 *
 * Deliberately absent, all of them out of scope for this feature rather than
 * unfinished: drag-and-drop, a progress bar (the whole upload is one PUT of a few
 * megabytes, and a fake bar would be the honest-kind-of-dishonest), multiple files at
 * once, cropping or resizing (there is no image-processing pipeline in this project at
 * all — a recorded gap), a gallery of previously uploaded images, and an
 * "上传并发布" shortcut. Publishing stays the separate button it already is.
 */

type Stage = 'idle' | 'signing' | 'uploading' | 'verifying' | 'done';

/**
 * What the button says while each step is in flight, named after the step rather than
 * reduced to "上传中...": the three steps fail for three different reasons (the API is
 * down, the browser is on the wrong origin, the bytes were refused), and a person who
 * can see *which* step hung is the person who can report it usefully.
 */
const BUSY_LABELS: Record<'signing' | 'uploading' | 'verifying', string> = {
  signing: '申请签名...',
  uploading: '直传对象存储...',
  verifying: '服务器核验字节...',
};

/**
 * Byte count for humans. `ImportMarkdownPanel.tsx` carries a private twin of this
 * (`formatKiB`) for markdown character counts; both are three lines and they are not
 * the same unit's number, so neither is extracted for a second caller. If a third one
 * appears, they belong in `src/lib/` together.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * The four local refusals: no type reported, a type outside the four, an empty file,
 * and a declared size over the page's assumed cap.
 *
 * **Not the check.** `File.type` is what the browser *guessed* from the extension and
 * the OS, and it can be wrong or empty; the server's magic-byte sniff is the gate, and
 * a file that passes everything below can still come back 415. Nothing here opens the
 * bytes — sniffing client-side would put a second parser in the project, and the parser
 * the backend exists to own is one file (`apps/api/src/modules/uploads/service.ts`).
 *
 * What this saves is a signature and a few megabytes of someone's upload on a
 * foregone conclusion, which is the same reasoning behind the server's own
 * declared-size check. `MAX_UPLOAD_BYTES_HINT` is a mirror of a configuration value, so
 * the wording says which number is authoritative.
 */
function refuseLocally(file: File): string | null {
  const allowed = ALLOWED_UPLOAD_CONTENT_TYPES.join(' / ');

  if (file.type === '') {
    return `浏览器没能报出「${file.name}」的类型，签名这一步会被直接拒掉。把它另存成 ${allowed} 之一的扩展名后再选。`;
  }
  if (!isAllowedContentType(file.type)) {
    return `「${file.name}」报出的类型是 ${file.type}，不在可上传的类型里（${allowed}）。换一张 PNG / JPEG / GIF / WebP 再试。`;
  }
  if (file.size === 0) {
    return `「${file.name}」是 0 字节，不可能是这四类图片之一，服务器不会为它签发上传。`;
  }
  if (file.size > MAX_UPLOAD_BYTES_HINT) {
    return `「${file.name}」约 ${formatBytes(file.size)}，超过本页预检用的上限 ${formatBytes(MAX_UPLOAD_BYTES_HINT)}。真正生效的是服务器上配置的那个上限，这里只是一个提前拦。`;
  }
  return null;
}

/**
 * Failure text for a thrown step, with one thing added and nothing invented.
 *
 * `describeApiError` forwards the API's own message, which is right for steps 1 and 3
 * (`Unsupported image type '…'`, `Uploaded bytes are …, which does not match the … key
 * this was signed for`, `Uploaded object is … bytes, over the … limit`), so no screen
 * string paraphrases it. What gets *added* is only the thing a person cannot infer
 * from that message, and it is scoped per step because the three steps leave different
 * things behind:
 *
 * - refused at `verifying` (415 / 413): the server deleted the object, so there is
 *   genuinely nothing to tidy up — the sentence that keeps the admin from hunting for a
 *   cleanup step.
 * - refused at `signing` (the same 415 / 413 on the *declared* values): no object ever
 *   existed, so the same sentence would describe something that did not happen. Silent.
 * - step 2 throwing something that is not an `ApiError`: that is the browser refusing
 *   to finish the cross-origin request, and the one cause worth naming here is the page
 *   being opened on `127.0.0.1` (see `putPresignedObject`).
 *
 * What no branch claims is that a failure always leaves the bucket clean: if the PUT
 * succeeded and the `complete` call itself failed for a reason other than a refusal —
 * an expired session, say — the object is in the bucket and unreferenced. That case is
 * the backend's recorded gap (there is no key ledger to sweep), not something the
 * button can fix.
 */
function describeFailure(step: Stage, error: unknown): string {
  const message = describeApiError(error, '上传失败，请重试。');

  if (error instanceof ApiError) {
    const refused =
      error.code === ERROR_CODES.unsupportedMediaType || error.code === ERROR_CODES.payloadTooLarge;
    if (refused && step === 'verifying') {
      return `${message}（被拒绝的对象服务器已经删掉了，你不需要清理任何东西；重新选一个文件即可。）`;
    }
    return message;
  }

  if (step === 'uploading') {
    return `${message}（直传对象存储不经我们的 API，浏览器被跨源挡住时不会给回原因。先确认页面开在 http://localhost:5175，而不是 127.0.0.1:5175——桶的 CORS 允许清单是精确字符串匹配，不做这两种写法的归一。）`;
  }

  return message;
}

export default function CoverImageUpload({ onUploaded }: { onUploaded: (publicUrl: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>('idle');
  /** The server's measurement of what actually landed, shown only once it exists. */
  const [measured, setMeasured] = useState<CompletedUpload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busyLabel =
    stage === 'signing' || stage === 'uploading' || stage === 'verifying'
      ? BUSY_LABELS[stage]
      : null;

  const handlePick = async (picked: FileList | null) => {
    if (!picked || picked.length === 0) return;
    const file = picked[0];

    setError(null);
    setMeasured(null);

    // Tracks the step for the failure wording; `stage` is render state and this is the
    // value that was true when the `await` actually rejected.
    let step: Stage = 'signing';

    try {
      const refusal = refuseLocally(file);
      if (refusal !== null) {
        setError(refusal);
        return;
      }

      step = 'signing';
      setStage('signing');
      const signed = await requestUpload(file.type, file.size);

      step = 'uploading';
      setStage('uploading');
      await putPresignedObject(signed.uploadUrl, file, file.type);

      step = 'verifying';
      setStage('verifying');
      const completed = await completeUpload(signed.key);

      setMeasured(completed);
      setStage('done');
      onUploaded(completed.publicUrl);
    } catch (caught) {
      setStage('idle');
      setError(describeFailure(step, caught));
    } finally {
      // So picking the same file a second time still fires `change`.
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="mt-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(event) => void handlePick(event.target.files)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => inputRef.current?.click()}
          disabled={busyLabel !== null}
          className="flex items-center gap-2 px-3 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Upload className="w-4 h-4" />
          {busyLabel ?? '上传'}
        </button>
        <span className="text-xs text-muted-foreground">
          {stage === 'idle'
            ? `上传成功后地址会自动填进上面的框。${ALLOWED_UPLOAD_CONTENT_TYPES.join(' / ')}；手填 URL 这条路照旧可用。`
            : null}
        </span>
      </div>

      {error && (
        <div className="mt-2 text-xs px-3 py-2 rounded-md bg-red-500/10 text-red-600 border border-red-500/30">
          {error}
        </div>
      )}

      {measured && stage === 'done' && (
        <div className="mt-2 text-xs px-3 py-2 rounded-md bg-green-500/10 text-green-600 border border-green-500/30">
          已上传：{formatBytes(measured.sizeBytes)} · {measured.contentType}
          <span className="opacity-80">
            （这两个数是服务器读回对象字节实测的，不是浏览器报的那份）
          </span>
          <div className="mt-1 opacity-80">地址已填进上面的框，点保存才会写进这篇文章。</div>
        </div>
      )}
    </div>
  );
}
