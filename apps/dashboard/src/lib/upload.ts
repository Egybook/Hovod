import { api } from './api.js';

/** S3 multipart part size. Files smaller than this go up in one plain PUT. */
export const PART_SIZE = 16 * 1024 * 1024;
/** Hard client-side ceiling; the API/storage would reject bigger files anyway. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024 * 1024;
export const MAX_UPLOAD_LABEL = '20 GB';

const PART_ATTEMPTS = 8;
const PART_CONCURRENCY = 1; // Keep mobile/R2 uploads sequential for connection stability.
const SESSION_PREFIX = 'hovod_upload_';

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

interface StoredSession {
  uploadId: string;
  fileName: string;
  fileSize: number;
  lastModified: number;
  /** The part size the already-uploaded parts were cut with. */
  partSize: number;
  parts: CompletedPart[];
}

/* ─── Resumable session state (survives a Retry within the tab) ─────────── */

/** In-memory mirror — sessionStorage can be unavailable (private mode, quotas). */
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

function readStoredSession(assetId: string): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(sessionKey(assetId));
    return raw ? JSON.parse(raw) as StoredSession : null;
  } catch {
    return null;
  }
}

function writeSession(assetId: string, session: StoredSession): void {
  memorySessions.set(assetId, session);
  try {
    sessionStorage.setItem(sessionKey(assetId), JSON.stringify(session));
  } catch { /* best effort — the in-memory copy still allows a resume */ }
}

export function clearSession(assetId: string): void {
  memorySessions.delete(assetId);
  try {
    sessionStorage.removeItem(sessionKey(assetId));
  } catch { /* ignore */ }
}

/** The uploadId of an unfinished upload, if any — used to abort on give-up. */
export function pendingUploadId(assetId: string): string | null {
  return (memorySessions.get(assetId) ?? readStoredSession(assetId))?.uploadId ?? null;
}

/* ─── Raw PUT of one blob to a presigned URL ───────────────────────────── */

interface PutResult { etag: string | null }

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
    xhr.open('PUT', url);
    if (contentType) xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
    xhr.onload = () => {
      signal?.removeEventListener('abort', abort);
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(blob.size);
        resolve({ etag: xhr.getResponseHeader('ETag') });
      } else {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => { signal?.removeEventListener('abort', abort); reject(new Error('Network connection was interrupted while uploading to storage')); };
    xhr.ontimeout = () => { signal?.removeEventListener('abort', abort); reject(new Error('Upload connection timed out')); };
    xhr.onabort = () => { signal?.removeEventListener('abort', abort); reject(new DOMException('Upload aborted', 'AbortError')); };
    if (signal) {
      if (signal.aborted) { reject(new DOMException('Upload aborted', 'AbortError')); return; }
      signal.addEventListener('abort', abort, { once: true });
    }
    xhr.send(blob);
  });
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
 * Files below 16 MiB use a single presigned PUT. Larger files use sequential
 * 16 MiB multipart chunks, per-part retries, and resumable session state.
 */
export async function uploadVideoFile(opts: UploadOptions): Promise<void> {
  if (opts.file.size < PART_SIZE) return singlePutUpload(opts);
  return multipartUpload(opts);
}

async function singlePutUpload({ assetId, file, signal, onProgress }: UploadOptions): Promise<void> {
  let lastError: unknown;
  // A fresh presigned URL is requested for each attempt. Small uploads cannot
  // resume mid-file, so retry the complete PUT on transient mobile network loss.
  for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
    try {
      const { uploadUrl } = await api<{ uploadUrl: string }>(`/v1/assets/${assetId}/upload-url`, { method: 'POST' });
      await putBlob(uploadUrl, file, 'video/mp4', signal, (loaded) => {
        onProgress?.({
          percent: file.size ? Math.min(100, Math.round((loaded / file.size) * 100)) : 100,
          loaded,
          total: file.size,
          completedParts: 0,
          totalParts: 1,
        });
      });
      await api(`/v1/assets/${assetId}/upload-complete`, { method: 'POST' });
      return;
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastError = err;
      if (attempt < PART_ATTEMPTS) {
        onProgress?.({ percent: 0, loaded: 0, total: file.size, completedParts: 0, totalParts: 1 });
        await delay(retryDelay(attempt), signal);
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
      `/v1/assets/${assetId}/multipart/create`, { method: 'POST' },
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
        method: 'POST', body: JSON.stringify({ uploadId }), timeoutMs: 60_000,
      },
    );
  } catch (err) {
    // A stale/expired multipart session must not trap the user in a permanent
    // retry loop. Start a clean session; already completed uploads are caught
    // by the status endpoint above and never reach this branch.
    if (!resumed || (err as { status?: number })?.status !== 409) throw err;
    clearSession(assetId);
    const created = await api<{ uploadId: string; partSize: number; key: string }>(
      `/v1/assets/${assetId}/multipart/create`, { method: 'POST' },
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
  if (remote.completed) { clearSession(assetId); return; }
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
            body: JSON.stringify({ uploadId, partNumber }),
          });
          const { etag } = await putBlob(url, blob, '', signal, (loaded) => {
            loadedByPart.set(partNumber, loaded);
            emit();
          });
          if (!etag) {
            throw new Error('Storage did not return an ETag — the bucket must expose the ETag header (CORS)');
          }
          etags.set(partNumber, etag);
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
          if (attempt < PART_ATTEMPTS) await delay(retryDelay(attempt), signal);
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
