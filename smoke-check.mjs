import fs from 'node:fs';
import path from 'node:path';
import { adminShell } from './src/admin-shell.mjs';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const site = read('index.html');
const admin = adminShell();
const worker = read('src/index.mjs');
const migration = read('migrations/0001_ops_mvp.sql');
const manifest = JSON.parse(read('manifest.json'));
const inlineScripts = [...site.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((script) => script.trim());

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
assert(site.includes('Idempotency-Key'), 'Публичная заявка не защищена от повтора');
assert(site.includes('config.js'), 'Не подключён config.js');
assert(site.includes('onyxshopmail@gmail.com'), 'Неверный email');
assert(site.includes('onyxgrouptg'), 'Неверный Telegram-канал');
assert(site.includes('onyxgroupadmin'), 'Неверный Telegram-администратор');
assert(!/(i\.ebayimg|pricearchive|fifineaudio|unusual traffic)/i.test(site), 'В public site остались сторонние или заблокированные фото');
assert(duplicateIds(site).length === 0, `Повторяющиеся ID в index.html: ${duplicateIds(site).join(', ')}`);
for (const script of inlineScripts) new Function(script);
assert(duplicateIds(admin).length === 0, `Повторяющиеся ID в панели: ${duplicateIds(admin).join(', ')}`);
assert(admin.includes('Вход сотрудников'), 'Нет защищённого входа сотрудников');
assert(admin.includes('Товары и поставщики'), 'Нет панели товаров и поставщиков');
assert(worker.includes("'/api/orders'"), 'Нет orders API');
assert(worker.includes("'/api/auth/login'"), 'Нет входа сотрудников');
assert(worker.includes('trackingMatch'), 'Нет tracking API');
assert(worker.includes('env.STORAGE.put'), 'Worker не сохраняет изображения в R2');
for (const table of ['staff_users', 'customers', 'orders', 'order_items', 'supplier_orders', 'supplier_order_items', 'money_movements', 'automation_jobs']) {
  assert(migration.includes(`CREATE TABLE ${table}`), `В миграции нет таблицы ${table}`);
}
assert(manifest.manifest_version === 3, 'Расширение должно быть Manifest V3');
assert(manifest.permissions.includes('activeTab'), 'Расширению не хватает activeTab');
console.log('Smoke check: OK');
