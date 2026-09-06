import test from 'node:test';
import assert from 'node:assert/strict';
import {
  originAllowed,
  mediaExtension,
} from './src/index.mjs';

test('originAllowed supports wildcard and explicit origins', () => {
  assert.equal(originAllowed('https://site.github.io', '*'), true);
  assert.equal(originAllowed('https://site.github.io', 'https://site.github.io,https://example.com'), true);
  assert.equal(originAllowed('https://evil.test', 'https://site.github.io'), false);
  assert.equal(originAllowed('', 'https://site.github.io'), true);
});

test('mediaExtension maps known image content types', () => {
  assert.equal(mediaExtension('image/jpeg'), 'jpg');
  assert.equal(mediaExtension('image/webp'), 'webp');
  assert.equal(mediaExtension('image/avif'), 'avif');
});
