import test from 'node:test';
import assert from 'node:assert/strict';
import { countMultipartParts, MIB, MIN_MULTIPART_FILE_SIZE, shouldUseMultipart } from '../src/lib/upload-policy.js';

test('files at or below 5 MiB stay on single PUT', () => {
  assert.equal(shouldUseMultipart(1 * MIB), false);
  assert.equal(shouldUseMultipart(MIN_MULTIPART_FILE_SIZE), false);
});

test('files above 5 MiB use resumable multipart', () => {
  assert.equal(shouldUseMultipart(MIN_MULTIPART_FILE_SIZE + 1), true);
  assert.equal(shouldUseMultipart(Math.round(9.8 * MIB)), true);
});

test('9.8 MiB upload splits into two independently retryable R2 parts', () => {
  const fileSize = Math.round(9.8 * MIB);
  assert.equal(countMultipartParts(fileSize, 5 * MIB), 2);
  assert.ok(fileSize - 5 * MIB > 0);
});
