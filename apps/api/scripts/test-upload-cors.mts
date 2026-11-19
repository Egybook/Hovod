import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectUploadCors } from '../src/services/upload-cors.js';

test('a single matching R2 rule allowing origin, PUT and Content-Type is accepted', () => {
  const result = inspectUploadCors([{
    AllowedOrigins: ['https://egybook.github.io'],
    AllowedMethods: ['GET', 'PUT'],
    AllowedHeaders: ['content-type'],
    ExposeHeaders: ['ETag'],
  }], 'https://egybook.github.io');
  assert.equal(result.allowed, true);
  assert.equal(result.etagExposed, true);
});

test('wildcard subdomain origin matches the configured host pattern', () => {
  const result = inspectUploadCors([{
    AllowedOrigins: ['https://*.example.com'],
    AllowedMethods: ['PUT'],
    AllowedHeaders: ['*'],
  }], 'https://videos.example.com');
  assert.equal(result.allowed, true);
});

test('values from separate rules are not incorrectly combined', () => {
  const result = inspectUploadCors([
    { AllowedOrigins: ['https://egybook.github.io'], AllowedMethods: ['GET'], AllowedHeaders: ['*'] },
    { AllowedOrigins: ['https://other.example'], AllowedMethods: ['PUT'], AllowedHeaders: ['Content-Type'] },
  ], 'https://egybook.github.io');
  assert.equal(result.originAllowed, true);
  assert.equal(result.putAllowed, true);
  assert.equal(result.contentTypeAllowed, true);
  assert.equal(result.allowed, false);
});

test('ETag exposure is optional when the server reconciles parts', () => {
  const result = inspectUploadCors([{
    AllowedOrigins: ['https://egybook.github.io'],
    AllowedMethods: ['PUT'],
    AllowedHeaders: ['Content-Type'],
  }], 'https://egybook.github.io');
  assert.equal(result.allowed, true);
  assert.equal(result.etagExposed, false);
});

test('invalid multi-wildcard origins do not match Cloudflare R2 rules', () => {
  const result = inspectUploadCors([{
    AllowedOrigins: ['https://*.*.example.com'],
    AllowedMethods: ['PUT'],
    AllowedHeaders: ['*'],
  }], 'https://a.b.example.com');
  assert.equal(result.allowed, false);
});
