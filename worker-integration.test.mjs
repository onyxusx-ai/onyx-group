import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.mjs';

class FakeBucket {
  constructor() { this.values = new Map(); }
  async put(key, value, options = {}) {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
    this.values.set(key, { bytes, options });
  }
  async get(key) {
    const entry = this.values.get(key);
    if (!entry) return null;
    return {
      body: entry.bytes,
      httpEtag: '"fake-etag"',
      async text() { return new TextDecoder().decode(entry.bytes); },
      writeHttpMetadata(headers) {
        if (entry.options.httpMetadata?.contentType) headers.set('content-type', entry.options.httpMetadata.contentType);
        if (entry.options.httpMetadata?.cacheControl) headers.set('cache-control', entry.options.httpMetadata.cacheControl);
      },
    };
  }
  async delete(key) { this.values.delete(key); }
}

test('worker imports exact listing image into storage and returns catalog', async () => {
  const bucket = new FakeBucket();
  const env = { STORAGE: bucket, ADMIN_TOKEN: 'secret', ALLOWED_ORIGINS: '*' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://cdn.example.com/listing-photo.jpg') {
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    return originalFetch(input);
  };

  try {
    const importResponse = await worker.fetch(new Request('https://api.example.com/api/import', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        sourceUrl: 'https://detail.1688.com/offer/123.html',
        platform: '1688',
        title: 'Listing item',
        images: ['https://cdn.example.com/listing-photo.jpg'],
      }),
    }), env);
    assert.equal(importResponse.status, 201);
    const imported = await importResponse.json();
    assert.equal(imported.ok, true);
    assert.equal(imported.product.images.length, 1);

    const catalogResponse = await worker.fetch(new Request('https://api.example.com/api/products'), env);
    const catalog = await catalogResponse.json();
    assert.equal(catalog.products[0].title, 'Listing item');
    assert.match(catalog.products[0].images[0], /^\/media\/products\//);

    const mediaResponse = await worker.fetch(new Request(`https://api.example.com${catalog.products[0].images[0]}`), env);
    assert.equal(mediaResponse.status, 200);
    assert.deepEqual([...new Uint8Array(await mediaResponse.arrayBuffer())], [1, 2, 3, 4]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
