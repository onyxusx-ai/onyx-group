const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const v6 = fs.readFileSync(path.join(root, 'docs', 'V6_REFERENCE_SECTION_LIST.txt'), 'utf8').trim().split(/\r?\n/);

test('all major V6 sections are preserved', () => {
  for (const id of v6) assert.match(html, new RegExp(`id=["']${id}["']`), `missing V6 section ${id}`);
});

test('V6 signature features remain', () => {
  for (const signature of ['introOverlay','brandReplay','realRouteMap','managerTrackForm','leaflet','calcQuoteBtn','CHINA → RU']) {
    assert.ok(html.includes(signature), `missing V6 signature ${signature}`);
  }
});

test('marketplace additions exist without replacing V6 catalog', () => {
  for (const term of ['marketplaceSearchForm','Alibaba','1688','Taobao','AliExpress','Poizon','Pinduoduo','openProductSource','startOnyxOrder']) assert.ok(html.includes(term), `missing ${term}`);
  assert.ok(html.includes('id="productGrid"'));
});

test('calculator and individual order are separate sections', () => {
  const calc = html.indexOf('id="calculator"');
  const quote = html.indexOf('id="quote"');
  assert.ok(calc >= 0 && quote > calc);
  assert.ok(html.indexOf('</section>', calc) < quote);
});

test('Telegram destinations are correct', () => {
  assert.match(html, /https:\/\/t\.me\/onyxgrouptg/);
  assert.match(html, /https:\/\/t\.me\/onyxshopadmin/);
  assert.match(html, /t\.me\/share\/url/);
});

test('no duplicate HTML ids', () => {
  const ids = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map(m => m[1]);
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  assert.deepEqual(dupes, []);
});

test('inline JavaScript parses', () => {
  const match = html.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/);
  assert.ok(match, 'inline script missing');
  new vm.Script(match[1]);
});
