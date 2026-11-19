import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseMultipartPartSize, countMultipartParts, MIB, MIN_MULTIPART_PART_SIZE, MAX_R2_OBJECT_SIZE } from '../src/services/multipart-upload.js';

test('small mobile videos use 5 MiB chunks', () => {
  const size = Math.round(9.8 * MIB);
  const partSize = chooseMultipartPartSize(size);
  assert.equal(partSize, MIN_MULTIPART_PART_SIZE);
  assert.equal(countMultipartParts(size, partSize), 2);
});

test('medium and large videos use efficient chunks', () => {
  assert.equal(chooseMultipartPartSize(64 * MIB), 8 * MIB);
  assert.equal(chooseMultipartPartSize(256 * MIB), 16 * MIB);
});

test('part counts remain under R2 maximum for a 20 GiB file', () => {
  const size = 20 * 1024 * MIB;
  const partSize = chooseMultipartPartSize(size);
  assert.ok(countMultipartParts(size, partSize) <= 10_000);
  assert.ok(partSize >= MIN_MULTIPART_PART_SIZE);
});

test('maximum R2 object size stays within the 10,000-part limit', () => {
  const partSize = chooseMultipartPartSize(MAX_R2_OBJECT_SIZE);
  assert.ok(partSize <= 5 * 1024 * MIB);
  assert.ok(countMultipartParts(MAX_R2_OBJECT_SIZE, partSize) <= 10_000);
});
