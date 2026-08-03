import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const site = read('site/index.html');
const admin = read('site/admin.html');
const worker = read('worker/src/index.mjs');
const manifest = JSON.parse(read('extension/manifest.json'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function duplicateIds(html) {
  const ids = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map((match) => match[1]);
  return ids.filter((id, index) => ids.indexOf(id) !== index);
}

for (const id of ['catalog', 'calculator', 'quote', 'tracking', 'warehouse', 'faq', 'contacts']) {
  assert(site.includes(`id="${id}"`), `Нет обязательного раздела #${id}`);
}
assert(site.includes('const STATIC_PRODUCTS = [];'), 'В коде остались старые демонстрационные товары');
assert(site.includes('loadLiveCatalog'), 'Не подключён живой каталог');
assert(site.includes('config.js'), 'Не подключён config.js');
assert(site.includes('onyxshopmail@gmail.com'), 'Неверный email');
assert(site.includes('onyxgrouptg'), 'Неверный Telegram-канал');
assert(site.includes('onyxgroupadmin'), 'Неверный Telegram-администратор');
assert(!/(i\.ebayimg|pricearchive|fifineaudio|unusual traffic)/i.test(site), 'В public site остались сторонние/заблокированные фото');
assert(duplicateIds(site).length === 0, `Повторяющиеся ID в index.html: ${duplicateIds(site).join(', ')}`);
assert(duplicateIds(admin).length === 0, `Повторяющиеся ID в admin.html: ${duplicateIds(admin).join(', ')}`);
assert(admin.includes('Добавить товар в ONYX'), 'Нет Safari bookmarklet');
assert(worker.includes('/api/import'), 'Нет import API');
assert(worker.includes('/api/products'), 'Нет products API');
assert(worker.includes('/api/orders'), 'Нет orders API');
assert(worker.includes('trackingMatch') && worker.includes('handleTracking'), 'Нет tracking API');
assert(worker.includes('env.STORAGE.put'), 'Worker не сохраняет изображения в R2');
assert(manifest.manifest_version === 3, 'Расширение должно быть Manifest V3');
assert(manifest.permissions.includes('activeTab'), 'Расширению не хватает activeTab');
console.log('Smoke check: OK');
