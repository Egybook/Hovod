/** R2 multipart constraints and adaptive chunk sizing. */
export const MIB = 1024 * 1024;
export const MIN_MULTIPART_PART_SIZE = 5 * MIB;
export const DEFAULT_MULTIPART_PART_SIZE = 16 * MIB;
export const MAX_MULTIPART_PARTS = 10_000;
export const MAX_R2_OBJECT_SIZE = 5 * 1024 * 1024 * 1024 * 1024;
export const MAX_R2_PART_SIZE = 5 * 1024 * MIB;

/**
 * Use smaller chunks for mobile-sized uploads so that a 5–32 MiB video is
 * split into independently retryable parts. Larger uploads use wider chunks
 * to avoid thousands of serial requests while staying below R2's part limit.
 */
export function chooseMultipartPartSize(fileSize?: number): number {
  if (!Number.isSafeInteger(fileSize) || !fileSize || fileSize <= 0) {
    return DEFAULT_MULTIPART_PART_SIZE;
  }
  let preferred: number;
  if (fileSize <= 32 * MIB) preferred = MIN_MULTIPART_PART_SIZE;
  else if (fileSize <= 128 * MIB) preferred = 8 * MIB;
  else preferred = DEFAULT_MULTIPART_PART_SIZE;

  // Keep even a maximum-size R2 object within the 10,000-part ceiling.
  const requiredForPartLimit = Math.ceil(fileSize / MAX_MULTIPART_PARTS);
  const alignedRequired = Math.ceil(requiredForPartLimit / MIB) * MIB;
  return Math.min(MAX_R2_PART_SIZE, Math.max(preferred, MIN_MULTIPART_PART_SIZE, alignedRequired));
}

export function countMultipartParts(fileSize: number, partSize: number): number {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) return 0;
  if (!Number.isSafeInteger(partSize) || partSize < MIN_MULTIPART_PART_SIZE) return 0;
  return Math.ceil(fileSize / partSize);
}
