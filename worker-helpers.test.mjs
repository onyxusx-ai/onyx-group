import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAuthorized,
  originAllowed,
  normalizeCatalogProduct,
  mediaExtension,
} from '../worker/src/index.mjs';

test('isAuthorized checks bearer token', () => {
  assert.equal(isAuthorized(new Request('https://api.test', { headers: { authorization: 'Bearer secret' } }), { ADMIN_TOKEN: 'secret' }), true);
  assert.equal(isAuthorized(new Request('https://api.test', { headers: { authorization: 'Bearer wrong' } }), { ADMIN_TOKEN: 'secret' }), false);
});

test('originAllowed supports wildcard and explicit origins', () => {
  assert.equal(originAllowed('https://site.github.io', '*'), true);
  assert.equal(originAllowed('https://site.github.io', 'https://site.github.io,https://example.com'), true);
  assert.equal(originAllowed('https://evil.test', 'https://site.github.io'), false);
  assert.equal(originAllowed('', 'https://site.github.io'), true);
});

test('normalizeCatalogProduct creates stable product schema', () => {
  const product = normalizeCatalogProduct({
    sourceUrl: 'https://detail.1688.com/offer/1.html',
    platform: '1688',
    title: 'Exact product',
    images: ['https://cdn.example.com/a.jpg'],
    priceCny: '188',
  }, 'p-test');
  assert.equal(product.id, 'p-test');
  assert.equal(product.title, 'Exact product');
  assert.equal(product.platform, '1688');
  assert.equal(product.priceCny, 188);
  assert.deepEqual(product.remoteImages, ['https://cdn.example.com/a.jpg']);
});

test('mediaExtension maps known image content types', () => {
  assert.equal(mediaExtension('image/jpeg'), 'jpg');
  assert.equal(mediaExtension('image/webp'), 'webp');
  assert.equal(mediaExtension('image/avif'), 'avif');
});
