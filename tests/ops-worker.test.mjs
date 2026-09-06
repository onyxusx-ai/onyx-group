import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import worker, { runAutomationJob } from '../src/index.mjs';
import { TestD1 } from './d1-test-adapter.mjs';

const migrations = [
  path.resolve('migrations/0001_ops_mvp.sql'),
  path.resolve('migrations/0002_confirmed_business_model.sql'),
];
const migrate = (DB) => migrations.forEach((migration) => DB.migrate(migration));
const origin = 'https://onyxusx-ai.github.io';

function envFor(DB) {
  return { DB, SETUP_TOKEN: 'setup-secret', ADMIN_TOKEN: 'legacy-secret', ALLOWED_ORIGINS: `${origin},http://localhost:8787` };
}

async function call(env, pathname, { method = 'GET', body, headers = {}, cookie } = {}) {
  const requestHeaders = new Headers(headers);
  if (body !== undefined) requestHeaders.set('content-type', 'application/json');
  if (cookie) requestHeaders.set('cookie', cookie);
  requestHeaders.set('origin', origin);
  return worker.fetch(new Request(`https://ops.example.test${pathname}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, { waitUntil() {} });
}

function cookieFrom(response) {
  return response.headers.get('set-cookie').split(';')[0];
}

async function bootstrapAndLogin(env) {
  const setup = await call(env, '/api/admin/bootstrap', {
    method: 'POST',
    headers: { 'x-setup-token': 'setup-secret' },
    body: { email: 'owner@onyx.test', name: 'Владелец', password: 'strong-password-123' },
  });
  assert.equal(setup.status, 201);
  const login = await call(env, '/api/auth/login', {
    method: 'POST', body: { email: 'owner@onyx.test', password: 'strong-password-123' },
  });
  assert.equal(login.status, 200);
  return cookieFrom(login);
}

async function createStaffAndLogin(env, ownerCookie, role, email) {
  const created = await call(env, '/api/admin/staff', {
    method: 'POST', cookie: ownerCookie,
    body: { email, name: role, role, password: 'strong-password-123' },
  });
  assert.equal(created.status, 201);
  const login = await call(env, '/api/auth/login', { method: 'POST', body: { email, password: 'strong-password-123' } });
  assert.equal(login.status, 200);
  return cookieFrom(login);
}

test('сквозной сценарий: сайт → сохранение → защита от дубля → перезапуск → панель', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-ops-'));
  const databasePath = path.join(directory, 'ops.sqlite');
  let DB = new TestD1(databasePath);
  migrate(DB);
  let env = envFor(DB);
  const ownerCookie = await bootstrapAndLogin(env);

  const payload = {
    type: 'cart',
    customerName: 'Тестовый клиент',
    customerContact: '@test-customer',
    customerCity: 'Ташкент',
    saleCurrency: 'RUB',
    salesTotalMinor: 300_000,
    items: [{ name: 'Тестовый товар', qty: 2, saleUnitMinor: 150_000, currency: 'RUB' }],
  };
  const first = await call(env, '/api/orders', { method: 'POST', headers: { 'idempotency-key': 'site:test-order-001' }, body: payload });
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  const duplicate = await call(env, '/api/orders', { method: 'POST', headers: { 'idempotency-key': 'site:test-order-001' }, body: payload });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);

  DB.close();
  DB = new TestD1(databasePath);
  env = envFor(DB);
  const orders = await call(env, '/api/admin/orders', { cookie: ownerCookie });
  assert.equal(orders.status, 200);
  const orderRows = (await orders.json()).orders;
  assert.equal(orderRows.length, 1);
  assert.equal(orderRows[0].public_code, firstBody.order.code);

  t.after(() => { DB.close(); fs.rmSync(directory, { recursive: true, force: true }); });
});

test('цена, наличие, несколько поставщиков, роли, возврат и очередь ошибок', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-ops-'));
  const DB = new TestD1(path.join(directory, 'ops.sqlite'));
  migrate(DB);
  const env = envFor(DB);
  const ownerCookie = await bootstrapAndLogin(env);
  const managerCookie = await createStaffAndLogin(env, ownerCookie, 'manager', 'manager@onyx.test');
  const financeCookie = await createStaffAndLogin(env, ownerCookie, 'finance', 'finance@onyx.test');

  const productResponse = await call(env, '/api/admin/products', {
    method: 'POST', cookie: managerCookie,
    body: { sku: 'ONYX-TEST-1', name: 'Товар для распределения', salePriceMinor: 300_000, saleCurrency: 'RUB' },
  });
  assert.equal(productResponse.status, 201);
  const product = (await productResponse.json()).product;

  const supplierAResponse = await call(env, '/api/admin/suppliers', {
    method: 'POST', cookie: managerCookie, body: { name: 'WeChat Factory A', channel: 'wechat', defaultCurrency: 'CNY' },
  });
  const supplierA = (await supplierAResponse.json()).supplier;
  const supplierBResponse = await call(env, '/api/admin/suppliers', {
    method: 'POST', cookie: managerCookie, body: { name: 'WeChat Factory B', channel: 'wechat', defaultCurrency: 'CNY' },
  });
  const supplierB = (await supplierBResponse.json()).supplier;

  const rows = [
    { supplier: supplierA.name, product_sku: product.sku, supplier_sku: 'A-1', purchase_price_minor: 10_000, currency: 'CNY', stock_qty: 10, stock_status: 'in_stock', stale_after_hours: 24 },
    { supplier: supplierB.name, product_sku: product.sku, supplier_sku: 'B-1', purchase_price_minor: 11_000, currency: 'CNY', stock_qty: 0, stock_status: 'out_of_stock', stale_after_hours: 24 },
  ];
  const preview = await call(env, '/api/admin/offers/import', { method: 'POST', cookie: managerCookie, body: { rows, commit: false } });
  assert.equal(preview.status, 200);
  const commit = await call(env, '/api/admin/offers/import', { method: 'POST', cookie: managerCookie, body: { rows, commit: true } });
  assert.equal(commit.status, 201);
  const offers = (await (await call(env, '/api/admin/offers', { cookie: managerCookie })).json()).offers;
  const offerA = offers.find((offer) => offer.supplier_id === supplierA.id);
  const offerB = offers.find((offer) => offer.supplier_id === supplierB.id);

  const orderResponse = await call(env, '/api/orders', {
    method: 'POST', headers: { 'idempotency-key': 'site:test-order-002' },
    body: { buyerType: 'dropshipper', customerName: 'Клиент', customerContact: '+998 90 000 00 00', saleCurrency: 'RUB', salesTotalMinor: 300_000, items: [{ name: 'Товар', qty: 2, saleUnitMinor: 150_000, currency: 'RUB' }] },
  });
  const orderId = (await orderResponse.json()).order.id;
  const detail = await (await call(env, `/api/admin/orders/${orderId}`, { cookie: managerCookie })).json();
  assert.equal(detail.order.buyer_type, 'dropshipper');
  const orderItemId = detail.items[0].id;

  const paymentOne = await call(env, `/api/admin/orders/${orderId}/payments`, {
    method: 'POST', cookie: financeCookie, headers: { 'idempotency-key': 'manual-payment-001' },
    body: { method: 'bank_transfer', expectedAmountMinor: 100_000, currency: 'RUB', provider: 'Тестовый банк' },
  });
  assert.equal(paymentOne.status, 201);
  const paymentOneId = (await paymentOne.json()).payment.id;
  const duplicatePayment = await call(env, `/api/admin/orders/${orderId}/payments`, {
    method: 'POST', cookie: financeCookie, headers: { 'idempotency-key': 'manual-payment-001' },
    body: { method: 'bank_transfer', expectedAmountMinor: 100_000, currency: 'RUB' },
  });
  assert.equal((await duplicatePayment.json()).duplicate, true);
  assert.equal((await call(env, `/api/admin/payments/${paymentOneId}`, { method: 'PATCH', cookie: financeCookie, body: { action: 'confirm' } })).status, 403);
  const confirmedOne = await call(env, `/api/admin/payments/${paymentOneId}`, { method: 'PATCH', cookie: ownerCookie, body: { action: 'confirm' } });
  assert.equal((await confirmedOne.json()).orderPaymentStatus, 'partially_paid');
  assert.equal((await (await call(env, `/api/admin/payments/${paymentOneId}`, { method: 'PATCH', cookie: ownerCookie, body: { action: 'confirm' } })).json()).duplicate, true);

  const paymentTwo = await call(env, `/api/admin/orders/${orderId}/payments`, {
    method: 'POST', cookie: ownerCookie, headers: { 'idempotency-key': 'manual-payment-002' },
    body: { method: 'payment_provider', expectedAmountMinor: 200_000, currency: 'RUB', provider: 'Тестовый провайдер' },
  });
  const paymentTwoId = (await paymentTwo.json()).payment.id;
  const confirmedTwo = await call(env, `/api/admin/payments/${paymentTwoId}`, { method: 'PATCH', cookie: ownerCookie, body: { action: 'confirm' } });
  assert.equal((await confirmedTwo.json()).orderPaymentStatus, 'paid');

  const shipment = await call(env, `/api/admin/orders/${orderId}/shipments`, {
    method: 'POST', cookie: managerCookie, headers: { 'idempotency-key': 'cargo-shipment-001' },
    body: { cargoName: 'Тест Карго', trackingCode: 'CARGO-1', pieces: 2 },
  });
  assert.equal(shipment.status, 201);
  const shipmentId = (await shipment.json()).shipment.id;
  assert.equal((await call(env, `/api/admin/shipments/${shipmentId}`, { method: 'PATCH', cookie: managerCookie, body: { status: 'confirmed' } })).status, 403);
  const confirmedShipment = await call(env, `/api/admin/shipments/${shipmentId}`, { method: 'PATCH', cookie: ownerCookie, body: { status: 'confirmed' } });
  assert.equal((await confirmedShipment.json()).deliveryStatus, 'preparing');

  const changedPrice = await call(env, `/api/admin/orders/${orderId}/supplier-orders`, {
    method: 'POST', cookie: managerCookie,
    body: { supplierId: supplierA.id, items: [{ orderItemId, supplierOfferId: offerA.id, quantity: 1, expectedPurchaseUnitMinor: 9_000 }] },
  });
  assert.equal(changedPrice.status, 409);
  assert.ok((await changedPrice.json()).error.details.issues.some((issue) => issue.code === 'PRICE_CHANGED'));

  const firstAllocation = await call(env, `/api/admin/orders/${orderId}/supplier-orders`, {
    method: 'POST', cookie: managerCookie,
    body: { supplierId: supplierA.id, confirmReview: true, items: [{ orderItemId, supplierOfferId: offerA.id, quantity: 1, expectedPurchaseUnitMinor: 9_000 }] },
  });
  assert.equal(firstAllocation.status, 201);

  const noStock = await call(env, `/api/admin/orders/${orderId}/supplier-orders`, {
    method: 'POST', cookie: managerCookie,
    body: { supplierId: supplierB.id, confirmReview: true, items: [{ orderItemId, supplierOfferId: offerB.id, quantity: 1, expectedPurchaseUnitMinor: 11_000 }] },
  });
  assert.equal(noStock.status, 409);
  assert.ok((await noStock.json()).error.details.issues.some((issue) => issue.code === 'OUT_OF_STOCK'));

  rows[1].stock_qty = 5;
  rows[1].stock_status = 'in_stock';
  assert.equal((await call(env, '/api/admin/offers/import', { method: 'POST', cookie: managerCookie, body: { rows: [rows[1]], commit: true } })).status, 201);
  const refreshedOffers = (await (await call(env, '/api/admin/offers', { cookie: managerCookie })).json()).offers;
  const refreshedB = refreshedOffers.find((offer) => offer.supplier_id === supplierB.id);
  const secondAllocation = await call(env, `/api/admin/orders/${orderId}/supplier-orders`, {
    method: 'POST', cookie: managerCookie,
    body: { supplierId: supplierB.id, items: [{ orderItemId, supplierOfferId: refreshedB.id, quantity: 1, expectedPurchaseUnitMinor: 11_000 }] },
  });
  assert.equal(secondAllocation.status, 201);
  const splitDetail = await (await call(env, `/api/admin/orders/${orderId}`, { cookie: managerCookie })).json();
  assert.equal(splitDetail.supplierOrders.length, 2);

  const managerFinance = await call(env, `/api/admin/orders/${orderId}/money-movements`, {
    method: 'POST', cookie: managerCookie,
    body: { direction: 'in', category: 'revenue', status: 'actual', amountMinor: 300_000, currency: 'RUB' },
  });
  assert.equal(managerFinance.status, 403);
  const financeStatus = await call(env, `/api/admin/orders/${orderId}`, {
    method: 'PATCH', cookie: financeCookie, body: { orderStatus: 'checking' },
  });
  assert.equal(financeStatus.status, 403);
  const financeDetail = await (await call(env, `/api/admin/orders/${orderId}`, { cookie: financeCookie })).json();
  assert.match(financeDetail.order.customer_contact, /\*\*\*/);
  assert.equal(financeDetail.order.customer_address, null);

  assert.equal((await call(env, `/api/admin/orders/${orderId}`, { method: 'PATCH', cookie: managerCookie, body: { paymentStatus: 'paid', orderStatus: 'checking' } })).status, 200);
  assert.equal((await call(env, `/api/admin/orders/${orderId}/money-movements`, { method: 'POST', cookie: financeCookie, body: { direction: 'in', category: 'revenue', status: 'actual', amountMinor: 300_000, currency: 'RUB', externalEventId: 'payment-1' } })).status, 201);
  const repeatedMovement = await call(env, `/api/admin/orders/${orderId}/money-movements`, { method: 'POST', cookie: financeCookie, body: { direction: 'in', category: 'revenue', status: 'actual', amountMinor: 300_000, currency: 'RUB', externalEventId: 'payment-1' } });
  assert.equal((await repeatedMovement.json()).duplicate, true);
  assert.equal((await call(env, `/api/admin/orders/${orderId}/money-movements`, { method: 'POST', cookie: financeCookie, body: { direction: 'out', category: 'refund', status: 'actual', amountMinor: 50_000, currency: 'RUB', externalEventId: 'refund-1' } })).status, 201);
  const refundDetail = await (await call(env, `/api/admin/orders/${orderId}`, { cookie: financeCookie })).json();
  assert.equal(refundDetail.order.payment_status, 'partially_refunded');
  assert.equal(refundDetail.finance.actualOutMinor, 50_000);
  assert.equal(refundDetail.finance.actualMarginMinor, null);

  const badJobId = 'job_test_failure';
  const now = new Date().toISOString();
  DB.prepare(`INSERT INTO automation_jobs (id,order_id,idempotency_key,action_type,payload_json,status,run_after,created_at,updated_at)
    VALUES (?,?,?,?,?,'pending',?,?,?)`).bind(badJobId, orderId, 'bad-job-1', 'send_real_supplier_order', '{}', now, now, now).run();
  const run = await runAutomationJob(env, badJobId);
  assert.equal(run.failed, true);
  const jobs = await (await call(env, '/api/admin/jobs', { cookie: managerCookie })).json();
  assert.ok(jobs.jobs.some((job) => job.id === badJobId && job.status === 'failed'));
  const retry = await call(env, `/api/admin/jobs/${badJobId}/retry`, { method: 'POST', cookie: managerCookie });
  assert.equal(retry.status, 200);

  t.after(() => { DB.close(); fs.rmSync(directory, { recursive: true, force: true }); });
});
