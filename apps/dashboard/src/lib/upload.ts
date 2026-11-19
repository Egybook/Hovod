import { api, ApiError } from './api.js';
import { DEFAULT_PART_SIZE, shouldUseMultipart } from './upload-policy.js';

/** Default S3 part size; the API may choose a smaller part size for small videos. */
export const PART_SIZE = DEFAULT_PART_SIZE;
/** Hard client-side ceiling; the API/storage would reject bigger files anyway. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024 * 1024;
export const MAX_UPLOAD_LABEL = '20 GB';

const PART_ATTEMPTS = 8;
const PART_CONCURRENCY = 1; // Keep mobile/R2 uploads sequential for connection stability.
const SESSION_PREFIX = 'hovod_upload_';
const DRAFT_KEY = 'hovod_upload_pending_draft';

/** Containers browsers routinely report with an empty or wrong MIME type. */
const VIDEO_EXTENSIONS = [
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mpg', 'mpeg', 'wmv', 'flv', 'ts', 'm2ts', 'mts', '3gp', 'ogv',
];

export type FileRejection = 'type' | 'size';

/** Returns why a file cannot be uploaded, or null when it is acceptable. */
export function validateVideoFile(file: File): FileRejection | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const looksLikeVideo = file.type.startsWith('video/') || VIDEO_EXTENSIONS.includes(ext);
  if (!looksLikeVideo) return 'type';
  if (file.size > MAX_UPLOAD_BYTES) return 'size';
  return null;
}

export interface UploadProgress {
  /** 0-100, based on bytes actually acknowledged by the network layer. */
  percent: number;
  loaded: number;
  total: number;
  /** 0 for a single-PUT upload. */
  completedParts: number;
  totalParts: number;
}

interface CompletedPart { PartNumber: number; ETag: string }

export interface UploadDraft {
  assetId: string;
  fileName: string;
  fileSize: number;
  lastModified: number;
  title: string;
}

interface StoredSession {
  uploadId: string;
  fileName: string;
  fileSize: number;
  lastModified: number;
  /** The part size the already-uploaded parts were cut with. */
  partSize: number;
  parts: CompletedPart[];
}

/* ─── Resumable session state (survives Retry, reload, and tab reopening) ─ */

/** In-memory mirror — browser storage can be unavailable (private mode/quotas). */
const memorySessions = new Map<string, StoredSession>();

function sessionKey(assetId: string): string {
  return `${SESSION_PREFIX}${assetId}`;
}

function readSession(assetId: string, file: File): StoredSession | null {
  const inMemory = memorySessions.get(assetId);
  const stored = inMemory ?? readStoredSession(assetId);
  if (!stored) return null;
  // A different file under the same asset invalidates the resume data.
  if (stored.fileName !== file.name || stored.fileSize !== file.size || stored.lastModified !== file.lastModified) {
    clearSession(assetId);
    return null;
  }
  return stored;
}

function getLocalStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function getSessionStorage(): Storage | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}

function readStoredSession(assetId: string): StoredSession | null {
  const key = sessionKey(assetId);
  for (const storage of [getLocalStorage(), getSessionStorage()]) {
    try {
      const raw = storage?.getItem(key);
      if (raw) return JSON.parse(raw) as StoredSession;
    } catch { /* try the next storage backend */ }
  }
  return null;
}

function writeSession(assetId: string, session: StoredSession): void {
  memorySessions.set(assetId, session);
  const value = JSON.stringify(session);
  for (const storage of [getLocalStorage(), getSessionStorage()]) {
    try { storage?.setItem(sessionKey(assetId), value); } catch { /* best effort */ }
  }
}

export function clearSession(assetId: string): void {
  memorySessions.delete(assetId);
  for (const storage of [getLocalStorage(), getSessionStorage()]) {
    try { storage?.removeItem(sessionKey(assetId)); } catch { /* ignore */ }
  }
}

function isUploadDraft(value: unknown): value is UploadDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<UploadDraft>;
  return typeof draft.assetId === 'string' && typeof draft.fileName === 'string'
    && typeof draft.fileSize === 'number' && typeof draft.lastModified === 'number'
    && typeof draft.title === 'string';
}

/** Stores only the asset/file fingerprint, never the video bytes. */
export function readUploadDraft(): UploadDraft | null {
  for (const storage of [getLocalStorage(), getSessionStorage()]) {
    try {
      const raw = storage?.getItem(DRAFT_KEY);
      if (!raw) continue;
      const parsed: unknown = JSON.parse(raw);
      if (isUploadDraft(parsed)) return parsed;
    } catch { /* try the next storage backend */ }
  }
  return null;
}

export function writeUploadDraft(draft: UploadDraft): void {
  const value = JSON.stringify(draft);
  for (const storage of [getLocalStorage(), getSessionStorage()]) {
    try { storage?.setItem(DRAFT_KEY, value); } catch { /* best effort */ }
  }
}

export function clearUploadDraft(): void {
  for (const storage of [getLocalStorage(), getSessionStorage()]) {
    try { storage?.removeItem(DRAFT_KEY); } catch { /* ignore */ }
  }
}

/** The uploadId of an unfinished upload, if any — used to abort on give-up. */
export function pendingUploadId(assetId: string): string | null {
  return (memorySessions.get(assetId) ?? readStoredSession(assetId))?.uploadId ?? null;
}

/* ─── Raw PUT of one blob to a presigned URL ───────────────────────────── */

interface PutResult { etag: string | null }

class StorageUploadError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = 'StorageUploadError';
    this.status = status;
    this.retryable = retryable;
  }
}

function uploadTimeoutMs(blobSize: number): number {
  const mib = Math.max(1, Math.ceil(blobSize / (1024 * 1024)));
  return Math.max(180_000, Math.min(900_000, mib * 60_000));
}

function responseErrorMessage(xhr: XMLHttpRequest): string {
  const body = typeof xhr.responseText === 'string' ? xhr.responseText.trim() : '';
  if (!body) return `Storage returned HTTP ${xhr.status}`;
  const code = body.match(/<Code>([^<]+)<\/Code>/i)?.[1];
  const message = body.match(/<Message>([^<]+)<\/Message>/i)?.[1];
  const detail = [code, message].filter(Boolean).join(': ');
  return detail ? `Storage returned HTTP ${xhr.status} (${detail})` : `Storage returned HTTP ${xhr.status}`;
}

function putBlob(
  url: string,
  blob: Blob,
  contentType: string,
  signal: AbortSignal | undefined,
  onProgress: (loaded: number) => void,
): Promise<PutResult> {
  return new Promise<PutResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => signal?.removeEventListener('abort', abort);
    xhr.open('PUT', url);
    xhr.timeout = uploadTimeoutMs(blob.size);
    if (contentType) xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(blob.size);
        resolve({ etag: xhr.getResponseHeader('ETag') });
      } else {
        const retryable = xhr.status === 408 || xhr.status === 425 || xhr.status === 429 || xhr.status >= 500;
        reject(new StorageUploadError(responseErrorMessage(xhr), xhr.status, retryable));
      }
    };
    xhr.onerror = () => {
      cleanup();
      reject(new StorageUploadError('Network/CORS connection failed while uploading to storage', 0, true));
    };
    xhr.ontimeout = () => {
      cleanup();
      reject(new StorageUploadError('Storage upload timed out; the part can be retried safely', 0, true));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException('Upload aborted', 'AbortError'));
    };
    if (signal) {
      if (signal.aborted) { reject(new DOMException('Upload aborted', 'AbortError')); return; }
      signal.addEventListener('abort', abort, { once: true });
    }
    xhr.send(blob);
  });
}

function isRetryableUploadError(err: unknown): boolean {
  if (err instanceof StorageUploadError) return err.retryable;
  if (err instanceof ApiError) {
    return err.status === 408 || err.status === 425 || err.status === 429 || err.status >= 500;
  }
  return true; // Browser-level network errors do not expose an HTTP status.
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Upload aborted', 'AbortError')); return; }
    const finish = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
    const id = setTimeout(finish, ms);
    const onAbort = () => { clearTimeout(id); signal?.removeEventListener('abort', onAbort); reject(new DOMException('Upload aborted', 'AbortError')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitUntilOnline(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('Upload aborted', 'AbortError');
  if (typeof navigator === 'undefined' || navigator.onLine !== false) return;
  await new Promise<void>((resolve, reject) => {
    const onOnline = () => finish();
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Upload aborted', 'AbortError'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('online', onOnline);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = () => { cleanup(); resolve(); };
    const timer = setTimeout(finish, 120_000);
    window.addEventListener('online', onOnline, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else if (navigator.onLine !== false) finish();
  });
}

function retryDelay(attempt: number): number {
  // Exponential backoff with jitter; capped to avoid retry storms on mobile networks.
  const base = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/* ─── Public entry point ───────────────────────────────────────────────── */

export interface UploadOptions {
  assetId: string;
  file: File;
  signal?: AbortSignal;
  onProgress?: (p: UploadProgress) => void;
}

/**
 * Uploads a file to S3 and confirms it with the API.
 * Files up to 5 MiB use a single presigned PUT. Larger files use adaptive,
 * sequential R2 multipart chunks, per-part retries, and resumable session state.
 */
export async function uploadVideoFile(opts: UploadOptions): Promise<void> {
  let cors: {
    checked: boolean;
    allowed: boolean;
    originAllowed?: boolean;
    putAllowed?: boolean;
    contentTypeAllowed?: boolean;
    configured?: boolean;
  } | null = null;
  try {
    cors = await api<{
      checked: boolean; allowed: boolean; originAllowed?: boolean; putAllowed?: boolean;
      contentTypeAllowed?: boolean; configured?: boolean;
    }>(`/v1/assets/${opts.assetId}/multipart/diagnostics`, { signal: opts.signal, timeoutMs: 60_000 });
  } catch (err) {
    // A temporary diagnostics outage or an older API deployment must not
    // block a valid upload. The browser's actual R2 CORS preflight is final.
    if (!(err instanceof ApiError) || (err.status !== 404 && err.status !== 408 && err.status < 500)) throw err;
  }
  if (cors?.checked && !cors.allowed) {
    const detail = [
      cors.configured === false ? 'no CORS policy is configured' : null,
      cors.originAllowed === false ? 'the Hovod dashboard origin is not allowed' : null,
      cors.putAllowed === false ? 'PUT is not an allowed method' : null,
      cors.contentTypeAllowed === false ? 'Content-Type is not an allowed request header' : null,
    ].filter(Boolean).join('; ');
    throw new Error(`Cloudflare R2 browser upload is blocked by bucket CORS (${detail || 'policy mismatch'}). Allow this dashboard origin and PUT/Content-Type in the bucket CORS policy, then retry.`);
  }
  if (!shouldUseMultipart(opts.file.size)) return singlePutUpload(opts);
  return multipartUpload(opts);
}

async function singlePutUpload({ assetId, file, signal, onProgress }: UploadOptions): Promise<void> {
  let lastError: unknown;
  // A fresh presigned URL is requested for each attempt. Small uploads cannot
  // resume mid-file, so retry the complete PUT on transient mobile network loss.
  for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
    try {
      const { uploadUrl } = await api<{ uploadUrl: string }>(`/v1/assets/${assetId}/upload-url`, { method: 'POST', signal, timeoutMs: 60_000 });
      await putBlob(uploadUrl, file, 'video/mp4', signal, (loaded) => {
        onProgress?.({
          percent: file.size ? Math.min(100, Math.round((loaded / file.size) * 100)) : 100,
          loaded,
          total: file.size,
          completedParts: 0,
          totalParts: 1,
        });
      });
      await api(`/v1/assets/${assetId}/upload-complete`, { method: 'POST', signal, timeoutMs: 60_000 });
      return;
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastError = err;
      if (attempt < PART_ATTEMPTS && isRetryableUploadError(err)) {
        onProgress?.({ percent: 0, loaded: 0, total: file.size, completedParts: 0, totalParts: 1 });
        await waitUntilOnline(signal);
        await delay(retryDelay(attempt), signal);
      } else {
        break;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Upload failed after retries');
}

async function multipartUpload({ assetId, file, signal, onProgress }: UploadOptions): Promise<void> {
  const resumed = readSession(assetId, file);

  let uploadId: string;
  let partSize = PART_SIZE;
  let done: CompletedPart[];

  if (resumed) {
    uploadId = resumed.uploadId;
    partSize = resumed.partSize || PART_SIZE;
    done = resumed.parts;
  } else {
    const created = await api<{ uploadId: string; partSize: number; key: string }>(
      `/v1/assets/${assetId}/multipart/create`, { method: 'POST', body: JSON.stringify({ fileSize: file.size }), signal, timeoutMs: 60_000 },
    );
    uploadId = created.uploadId;
    partSize = created.partSize || PART_SIZE;
    done = [];
    writeSession(assetId, {
      uploadId,
      fileName: file.name,
      fileSize: file.size,
      lastModified: file.lastModified,
      partSize,
      parts: [],
    });
  }

  const totalParts = Math.ceil(file.size / partSize);
  if (totalParts > 10_000) {
    throw new Error('This file requires more than 10,000 storage parts. Increase the configured multipart part size.');
  }
  // Reconcile the browser's saved ETags with R2. This recovers a part that
  // reached storage even if the browser lost the response before saving it.
  let remote: { completed: boolean; parts: CompletedPart[] };
  try {
    remote = await api<{ completed: boolean; parts: CompletedPart[] }>(
      `/v1/assets/${assetId}/multipart/status`, {
        method: 'POST', body: JSON.stringify({ uploadId }), timeoutMs: 60_000, signal,
      },
    );
  } catch (err) {
    // A stale/expired multipart session must not trap the user in a permanent
    // retry loop. Start a clean session; already completed uploads are caught
    // by the status endpoint above and never reach this branch.
    if (!resumed || (err as { status?: number })?.status !== 409) throw err;
    clearSession(assetId);
    const created = await api<{ uploadId: string; partSize: number; key: string }>(
      `/v1/assets/${assetId}/multipart/create`, { method: 'POST', body: JSON.stringify({ fileSize: file.size }), signal, timeoutMs: 60_000 },
    );
    uploadId = created.uploadId;
    partSize = created.partSize || PART_SIZE;
    done = [];
    writeSession(assetId, {
      uploadId, fileName: file.name, fileSize: file.size,
      lastModified: file.lastModified, partSize, parts: [],
    });
    remote = { completed: false, parts: [] };
  }
  if (remote.completed) {
    // The object may have been completed just before a lost response. A newly
    // created session is unused in that case; release it to avoid orphaned parts.
    await api(`/v1/assets/${assetId}/multipart/abort`, {
      method: 'POST', body: JSON.stringify({ uploadId }),
    }).catch(() => {});
    clearSession(assetId);
    return;
  }
  done = remote.parts;
  const etags = new Map<number, string>(done.map((p) => [p.PartNumber, p.ETag]));
  // Bytes acknowledged per part, so overall progress survives a part retry.
  const loadedByPart = new Map<number, number>();
  for (const p of done) loadedByPart.set(p.PartNumber, partSizeOf(p.PartNumber, totalParts, partSize, file.size));

  const emit = () => {
    let loaded = 0;
    for (const n of loadedByPart.values()) loaded += n;
    onProgress?.({
      percent: file.size ? Math.min(100, Math.round((loaded / file.size) * 100)) : 100,
      loaded,
      total: file.size,
      completedParts: etags.size,
      totalParts,
    });
  };
  emit();

  const queue: number[] = [];
  for (let n = 1; n <= totalParts; n++) if (!etags.has(n)) queue.push(n);

  const worker = async () => {
    for (;;) {
      const partNumber = queue.shift();
      if (partNumber === undefined) return;
      if (signal?.aborted) throw new DOMException('Upload aborted', 'AbortError');

      const start = (partNumber - 1) * partSize;
      const blob = file.slice(start, Math.min(start + partSize, file.size));

      let lastError: unknown;
      for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
        try {
          // A fresh presigned URL per attempt — the previous one may have expired.
          const { url } = await api<{ url: string }>(`/v1/assets/${assetId}/multipart/part-url`, {
            method: 'POST',
            body: JSON.stringify({ uploadId, partNumber }), signal, timeoutMs: 60_000,
          });
          const { etag } = await putBlob(url, blob, '', signal, (loaded) => {
            loadedByPart.set(partNumber, loaded);
            emit();
          });
          let resolvedEtag = etag;
          if (!resolvedEtag) {
            // ExposeHeaders: ["ETag"] is optional: recover the ETag from
            // R2 through the authenticated API when the browser hides it.
            const reconciled = await api<{ completed: boolean; parts: CompletedPart[] }>(
              `/v1/assets/${assetId}/multipart/status`, {
                method: 'POST', body: JSON.stringify({ uploadId }), timeoutMs: 60_000, signal,
              },
            );
            resolvedEtag = reconciled.parts.find((part) => part.PartNumber === partNumber)?.ETag ?? null;
          }
          if (!resolvedEtag) {
            throw new Error(`Storage accepted part ${partNumber}, but its ETag could not be reconciled. Check the upload session and retry.`);
          }
          etags.set(partNumber, resolvedEtag);
          loadedByPart.set(partNumber, blob.size);
          persistParts(assetId, uploadId, file, partSize, etags);
          emit();
          lastError = undefined;
          break;
        } catch (err) {
          if (isAbortError(err)) throw err;
          lastError = err;
          loadedByPart.set(partNumber, 0);
          emit();
          if (attempt < PART_ATTEMPTS && isRetryableUploadError(err)) {
            await waitUntilOnline(signal);
            await delay(retryDelay(attempt), signal);
          } else {
            break;
          }
        }
      }
      if (lastError) throw lastError;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(PART_CONCURRENCY, Math.max(queue.length, 1)) }, worker),
  );

  const parts: CompletedPart[] = [];
  for (let n = 1; n <= totalParts; n++) {
    const etag = etags.get(n);
    if (!etag) throw new Error(`Part ${n} is missing — please retry the upload`);
    parts.push({ PartNumber: n, ETag: etag });
  }

  await api(`/v1/assets/${assetId}/multipart/complete`, {
    method: 'POST',
    body: JSON.stringify({ uploadId, parts }),
    timeoutMs: 300_000,
    signal,
  });
  clearSession(assetId);
}

function partSizeOf(partNumber: number, totalParts: number, partSize: number, fileSize: number): number {
  return partNumber === totalParts ? fileSize - (totalParts - 1) * partSize : partSize;
}

function persistParts(assetId: string, uploadId: string, file: File, partSize: number, etags: Map<number, string>): void {
  writeSession(assetId, {
    uploadId,
    fileName: file.name,
    fileSize: file.size,
    lastModified: file.lastModified,
    partSize,
    parts: [...etags.entries()]
      .map(([PartNumber, ETag]) => ({ PartNumber, ETag }))
      .sort((a, b) => a.PartNumber - b.PartNumber),
  });
}

/** Tell S3 to drop the parts of an upload the user gave up on. */
export async function abortUpload(assetId: string): Promise<void> {
  const uploadId = pendingUploadId(assetId);
  clearSession(assetId);
  if (!uploadId) return;
  await api(`/v1/assets/${assetId}/multipart/abort`, {
    method: 'POST',
    body: JSON.stringify({ uploadId }),
  }).catch(() => { /* best effort */ });
}
