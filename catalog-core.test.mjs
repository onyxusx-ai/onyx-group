import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPlatform,
  normalizeImageUrl,
  isSafeRemoteUrl,
  mapApiProduct,
} from '../shared/catalog-core.mjs';

test('detectPlatform recognizes supported marketplaces', () => {
  assert.equal(detectPlatform('https://www.aliexpress.com/item/1.html'), 'AliExpress');
  assert.equal(detectPlatform('https://detail.1688.com/offer/1.html'), '1688');
  assert.equal(detectPlatform('https://item.taobao.com/item.htm?id=1'), 'Taobao');
  assert.equal(detectPlatform('https://detail.tmall.com/item.htm?id=1'), 'Tmall');
  assert.equal(detectPlatform('https://www.alibaba.com/product-detail/x_1.html'), 'Alibaba');
  assert.equal(detectPlatform('https://mobile.yangkeduo.com/goods.html?goods_id=1'), 'Pinduoduo');
  assert.equal(detectPlatform('https://www.poizon.com/product/1'), 'Poizon');
});

test('normalizeImageUrl resolves protocol-relative and relative URLs', () => {
  assert.equal(normalizeImageUrl('//cdn.example.com/a.jpg', 'https://shop.example.com/item'), 'https://cdn.example.com/a.jpg');
  assert.equal(normalizeImageUrl('/images/a.webp', 'https://shop.example.com/item'), 'https://shop.example.com/images/a.webp');
  assert.equal(normalizeImageUrl('data:image/png;base64,abc', 'https://shop.example.com/item'), '');
});

test('isSafeRemoteUrl rejects local and private hosts', () => {
  assert.equal(isSafeRemoteUrl('https://cdn.example.com/a.jpg'), true);
  assert.equal(isSafeRemoteUrl('http://127.0.0.1/a.jpg'), false);
  assert.equal(isSafeRemoteUrl('http://10.0.0.1/a.jpg'), false);
  assert.equal(isSafeRemoteUrl('http://192.168.1.2/a.jpg'), false);
  assert.equal(isSafeRemoteUrl('http://localhost/a.jpg'), false);
});

test('mapApiProduct maps worker product into existing ONYX card model', () => {
  const mapped = mapApiProduct({
    id: 'p1',
    title: 'Exact Listing Product',
    description: 'Description',
    platform: '1688',
    sourceUrl: 'https://detail.1688.com/offer/1.html',
    priceText: '¥188',
    priceCny: 188,
    priceRub: 3890,
    category: 'clothes',
    type: 'Одежда',
    images: ['/media/a.webp'],
    deliveryDays: '20–25',
  }, 'https://api.example.com');

  assert.equal(mapped.id, 'p1');
  assert.equal(mapped.name, 'Exact Listing Product');
  assert.equal(mapped.source, '1688');
  assert.equal(mapped.image, 'https://api.example.com/media/a.webp');
  assert.equal(mapped.sourceUrl, 'https://detail.1688.com/offer/1.html');
});
