/** Shared browser-side upload strategy for reliable mobile transfers. */
export const MIB = 1024 * 1024;
export const MIN_MULTIPART_FILE_SIZE = 5 * MIB;
export const DEFAULT_PART_SIZE = 16 * MIB;
export const MAX_MULTIPART_PARTS = 10_000;

/**
 * Keep small uploads as one PUT. Anything above R2's 5 MiB non-final-part
 * minimum uses multipart so a dropped mobile connection only repeats one part.
 */
export function shouldUseMultipart(fileSize: number): boolean {
  return Number.isFinite(fileSize) && fileSize > MIN_MULTIPART_FILE_SIZE;
}

export function countMultipartParts(fileSize: number, partSize: number): number {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) return 0;
  if (!Number.isSafeInteger(partSize) || partSize < MIN_MULTIPART_FILE_SIZE) return 0;
  return Math.ceil(fileSize / partSize);
}
