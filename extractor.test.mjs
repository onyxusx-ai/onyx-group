import test from 'node:test';
import assert from 'node:assert/strict';
import { platformFromHostname, dedupeImageUrls, pickJsonLdProduct, parseNumericPrice } from '../extension/extractor-core.mjs';

test('platformFromHostname recognizes marketplace hosts', () => {
  assert.equal(platformFromHostname('detail.1688.com'), '1688');
  assert.equal(platformFromHostname('item.taobao.com'), 'Taobao');
  assert.equal(platformFromHostname('www.aliexpress.com'), 'AliExpress');
  assert.equal(platformFromHostname('detail.tmall.com'), 'Tmall');
});

test('dedupeImageUrls keeps usable product images only', () => {
  const result = dedupeImageUrls([
    '//cdn.example.com/a.jpg_400x400.jpg',
    'https://cdn.example.com/a.jpg_400x400.jpg',
    'data:image/png;base64,x',
    'https://cdn.example.com/icon.svg',
    'https://cdn.example.com/b.webp',
  ], 'https://shop.example.com/item');
  assert.deepEqual(result, [
    'https://cdn.example.com/a.jpg_400x400.jpg',
    'https://cdn.example.com/b.webp',
  ]);
});

test('pickJsonLdProduct finds Product object inside graph', () => {
  const result = pickJsonLdProduct([{ '@graph': [{ '@type': 'BreadcrumbList' }, { '@type': 'Product', name: 'Listing title', image: ['a.jpg'] }] }]);
  assert.equal(result.name, 'Listing title');
});

test('parseNumericPrice parses common price text', () => {
  assert.equal(parseNumericPrice('¥ 188.50'), 188.5);
  assert.equal(parseNumericPrice('US $12.99'), 12.99);
});
