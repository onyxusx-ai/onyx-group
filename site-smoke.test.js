const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('required marketplace and order sections exist', () => {
  for (const id of ['sources', 'calculator', 'quote', 'catalog', 'telegramHandoff']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});

test('calculator and individual order are separate sections', () => {
  const calcStart = html.indexOf('id="calculator"');
  const quoteStart = html.indexOf('id="quote"');
  assert.ok(calcStart >= 0 && quoteStart > calcStart);
  const calcClose = html.indexOf('</section>', calcStart);
  assert.ok(calcClose < quoteStart, 'quote must not be nested in calculator section');
});

test('correct Telegram destinations are present', () => {
  assert.match(html, /https:\/\/t\.me\/onyxgrouptg/);
  assert.match(html, /https:\/\/t\.me\/onyxshopadmin/);
  assert.doesNotMatch(html, /const TELEGRAM_USERNAME/);
});

test('major marketplace URL builders are present', () => {
  for (const domain of ['alibaba.com', '1688.com', 'taobao.com', 'aliexpress.com', 'poizon.com', 'pinduoduo.com']) {
    assert.ok(html.includes(domain), `missing ${domain}`);
  }
});

test('product cards expose source and ONYX order actions', () => {
  assert.match(html, /Открыть источник/);
  assert.match(html, /Заказать через ONYX/);
  assert.match(html, /function openProductSource/);
  assert.match(html, /function startOnyxOrder/);
});

test('no duplicate HTML ids', () => {
  const ids = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map(match => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], []);
});

test('inline JavaScript parses', () => {
  const match = html.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/);
  assert.ok(match, 'inline script not found');
  new vm.Script(match[1]);
});
