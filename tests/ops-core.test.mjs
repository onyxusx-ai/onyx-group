import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertTransition,
  calculateFinancialSnapshot,
  evaluateSupplierOffer,
  validateOfferImportRow,
} from '../src/ops-core.mjs';

test('статусы нельзя перескакивать через защищённые этапы', () => {
  assert.doesNotThrow(() => assertTransition('order', 'new', 'checking'));
  assert.throws(() => assertTransition('order', 'new', 'delivered'), /Недопустимый переход/);
  assert.throws(() => assertTransition('payment', 'refunded', 'paid'), /Недопустимый переход/);
});

test('неизвестные расходы не превращаются в ноль или прибыль', () => {
  const incomplete = calculateFinancialSnapshot({
    sale_currency: 'RUB',
    sales_total_minor: 100_000,
    discount_minor: 0,
    purchase_estimate_minor: null,
    delivery_cost_estimate_minor: 10_000,
    commission_cost_estimate_minor: 5_000,
    costs_complete: 0,
  }, []);
  assert.equal(incomplete.preliminaryMarginMinor, null);
  assert.equal(incomplete.actualMarginMinor, null);

  const complete = calculateFinancialSnapshot({
    sale_currency: 'RUB',
    sales_total_minor: 100_000,
    discount_minor: 5_000,
    purchase_estimate_minor: 50_000,
    delivery_cost_estimate_minor: 10_000,
    commission_cost_estimate_minor: 5_000,
    costs_complete: 1,
  }, [
    { status: 'actual', direction: 'in', amount_minor: 95_000, currency: 'RUB' },
    { status: 'actual', direction: 'out', amount_minor: 50_000, currency: 'RUB' },
    { status: 'actual', direction: 'out', amount_minor: 10_000, currency: 'RUB' },
  ]);
  assert.equal(complete.preliminaryMarginMinor, 30_000);
  assert.equal(complete.actualMarginMinor, 35_000);
});

test('отсутствие, устаревший остаток и новая цена требуют проверки', () => {
  const now = new Date('2026-09-06T12:00:00.000Z');
  const out = evaluateSupplierOffer({
    stock_status: 'out_of_stock', stock_qty: 0, purchase_price_minor: 1200,
    last_updated_at: '2026-09-06T11:00:00.000Z', stale_after_hours: 24,
  }, { quantity: 1, expectedPurchaseUnitMinor: 1000 }, now);
  assert.equal(out.allowed, false);
  assert.deepEqual(out.issues.map((issue) => issue.code), ['OUT_OF_STOCK', 'PRICE_CHANGED']);

  const stale = evaluateSupplierOffer({
    stock_status: 'in_stock', stock_qty: 10, purchase_price_minor: 1200,
    last_updated_at: '2026-09-01T11:00:00.000Z', stale_after_hours: 24,
  }, { quantity: 2, expectedPurchaseUnitMinor: 1200 }, now);
  assert.equal(stale.allowed, true);
  assert.equal(stale.requiresReview, true);
  assert.equal(stale.issues[0].code, 'STALE_OFFER');
});

test('строки импорта проверяются до записи', () => {
  const valid = validateOfferImportRow({
    supplier: 'Factory A', product_sku: 'ONYX-1', supplier_sku: 'WX-9',
    purchase_price_minor: '18800', currency: 'CNY', stock_qty: '7', stock_status: 'in_stock',
  });
  assert.equal(valid.errors.length, 0);
  assert.equal(valid.value.purchasePriceMinor, 18800);

  const invalid = validateOfferImportRow({ supplier: '', product_sku: '', currency: 'XXX', purchase_price_minor: '18.8' });
  assert.ok(invalid.errors.length >= 4);
});
