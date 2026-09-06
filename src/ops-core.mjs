export const ROLES = ['owner', 'manager', 'finance'];

export const ORDER_STATUSES = [
  'new',
  'checking',
  'awaiting_payment',
  'supplier_confirmation',
  'processing',
  'partially_shipped',
  'shipped',
  'delivered',
  'not_collected',
  'partially_returned',
  'returned',
  'problem',
  'cancelled',
];

export const PAYMENT_STATUSES = [
  'unpaid',
  'pending',
  'paid',
  'failed',
  'partially_refunded',
  'refunded',
  'cancelled',
];

export const DELIVERY_STATUSES = [
  'not_started',
  'preparing',
  'partially_shipped',
  'shipped',
  'partially_delivered',
  'delivered',
  'not_collected',
  'returning',
  'returned',
  'issue',
  'cancelled',
];

export const SUPPLIER_ORDER_STATUSES = [
  'draft',
  'awaiting_confirmation',
  'confirmed',
  'partially_shipped',
  'shipped',
  'delivered',
  'cancelled',
  'returned',
  'problem',
];

export const CURRENCIES = ['USD', 'UZS', 'RUB', 'KZT', 'TJS', 'KGS', 'BYN', 'EUR', 'CNY'];

const TRANSITIONS = {
  order: {
    new: ['checking', 'cancelled', 'problem'],
    checking: ['awaiting_payment', 'supplier_confirmation', 'cancelled', 'problem'],
    awaiting_payment: ['supplier_confirmation', 'cancelled', 'problem'],
    supplier_confirmation: ['processing', 'partially_shipped', 'cancelled', 'problem'],
    processing: ['partially_shipped', 'shipped', 'cancelled', 'problem'],
    partially_shipped: ['shipped', 'partially_returned', 'returned', 'problem'],
    shipped: ['delivered', 'partially_returned', 'returned', 'not_collected', 'problem'],
    delivered: ['partially_returned', 'returned'],
    not_collected: ['returned'],
    partially_returned: ['returned'],
    problem: ['checking', 'cancelled'],
    returned: [],
    cancelled: [],
  },
  payment: {
    unpaid: ['pending', 'paid', 'cancelled'],
    pending: ['paid', 'failed', 'cancelled'],
    failed: ['pending', 'paid', 'cancelled'],
    paid: ['partially_refunded', 'refunded'],
    partially_refunded: ['refunded'],
    refunded: [],
    cancelled: [],
  },
  delivery: {
    not_started: ['preparing', 'cancelled'],
    preparing: ['partially_shipped', 'shipped', 'issue', 'cancelled'],
    partially_shipped: ['shipped', 'partially_delivered', 'issue', 'returning'],
    shipped: ['partially_delivered', 'delivered', 'not_collected', 'returning', 'issue'],
    partially_delivered: ['delivered', 'returning', 'issue'],
    delivered: ['returning'],
    not_collected: ['returning'],
    returning: ['returned', 'issue'],
    issue: ['preparing', 'shipped', 'returning', 'cancelled'],
    returned: [],
    cancelled: [],
  },
  supplier_order: {
    draft: ['awaiting_confirmation', 'cancelled'],
    awaiting_confirmation: ['confirmed', 'cancelled', 'problem'],
    confirmed: ['partially_shipped', 'shipped', 'cancelled', 'problem'],
    partially_shipped: ['shipped', 'delivered', 'returned', 'problem'],
    shipped: ['delivered', 'returned', 'problem'],
    delivered: ['returned'],
    problem: ['awaiting_confirmation', 'cancelled'],
    cancelled: [],
    returned: [],
  },
};

export function canTransition(kind, from, to) {
  if (from === to) return true;
  return Boolean(TRANSITIONS[kind]?.[from]?.includes(to));
}

export function assertTransition(kind, from, to) {
  if (!TRANSITIONS[kind] || !Array.isArray(TRANSITIONS[kind][from])) {
    throw new Error(`Неизвестный текущий статус: ${kind}.${from}`);
  }
  if (!canTransition(kind, from, to)) {
    throw new Error(`Недопустимый переход статуса: ${from} → ${to}`);
  }
}

export function normalizeCurrency(value, fallback = null) {
  const currency = String(value || '').trim().toUpperCase();
  if (!currency && fallback) return normalizeCurrency(fallback);
  if (!CURRENCIES.includes(currency)) throw new Error(`Неподдерживаемая валюта: ${currency || 'не указана'}`);
  return currency;
}

export function normalizeMinor(value, { allowNull = true, field = 'Сумма' } = {}) {
  if (value === null || value === undefined || value === '') {
    if (allowNull) return null;
    throw new Error(`${field} не указана`);
  }
  const amount = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isSafeInteger(amount)) throw new Error(`${field} должна быть целым числом в минимальных единицах валюты`);
  return amount;
}

export function calculateFinancialSnapshot(order, movements = []) {
  const currency = order.sale_currency;
  const saleTotal = normalizeMinor(order.sales_total_minor);
  const discount = normalizeMinor(order.discount_minor) ?? 0;
  const estimates = [
    normalizeMinor(order.purchase_estimate_minor),
    normalizeMinor(order.delivery_cost_estimate_minor),
    normalizeMinor(order.commission_cost_estimate_minor),
  ];
  const estimatesKnown = saleTotal !== null && estimates.every((value) => value !== null);
  const preliminaryMarginMinor = estimatesKnown
    ? saleTotal - discount - estimates.reduce((sum, value) => sum + value, 0)
    : null;

  const actual = movements.filter((movement) => movement.status === 'actual' && movement.currency === currency);
  const actualInMinor = actual
    .filter((movement) => movement.direction === 'in')
    .reduce((sum, movement) => sum + Number(movement.amount_minor), 0);
  const actualOutMinor = actual
    .filter((movement) => movement.direction === 'out')
    .reduce((sum, movement) => sum + Number(movement.amount_minor), 0);
  const actualMarginMinor = Number(order.costs_complete) === 1 ? actualInMinor - actualOutMinor : null;

  const accruedRevenueMinor = saleTotal === null ? null : saleTotal - discount;
  const plannedOutMinor = movements
    .filter((movement) => movement.status === 'planned' && movement.direction === 'out' && movement.currency === currency)
    .reduce((sum, movement) => sum + Number(movement.amount_minor), 0);

  return {
    currency,
    accruedRevenueMinor,
    plannedOutMinor,
    preliminaryMarginMinor,
    actualInMinor,
    actualOutMinor,
    actualMarginMinor,
    costsComplete: Number(order.costs_complete) === 1,
  };
}

export function evaluateSupplierOffer(offer, request, now = new Date()) {
  const issues = [];
  const quantity = Number(request.quantity || 0);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    issues.push({ code: 'INVALID_QUANTITY', severity: 'block', message: 'Количество должно быть положительным целым числом.' });
  }

  if (!offer) {
    issues.push({ code: 'OFFER_NOT_FOUND', severity: 'block', message: 'Предложение поставщика не найдено.' });
    return { allowed: false, requiresReview: true, issues };
  }

  if (offer.stock_status === 'out_of_stock') {
    issues.push({ code: 'OUT_OF_STOCK', severity: 'block', message: 'Поставщик указал отсутствие товара.' });
  } else if (offer.stock_status !== 'in_stock') {
    issues.push({ code: 'STOCK_UNKNOWN', severity: 'review', message: 'Остаток не подтверждён.' });
  } else if (offer.stock_qty !== null && Number(offer.stock_qty) < quantity) {
    issues.push({ code: 'INSUFFICIENT_STOCK', severity: 'block', message: 'Подтверждённого остатка недостаточно.' });
  }

  const updatedAt = new Date(offer.last_updated_at);
  const staleAfterHours = Number(offer.stale_after_hours || 24);
  if (!Number.isFinite(updatedAt.getTime()) || now.getTime() - updatedAt.getTime() > staleAfterHours * 3_600_000) {
    issues.push({ code: 'STALE_OFFER', severity: 'review', message: 'Цена или остаток устарели — требуется подтверждение поставщика.' });
  }

  if (request.expectedPurchaseUnitMinor !== null && request.expectedPurchaseUnitMinor !== undefined
      && Number(request.expectedPurchaseUnitMinor) !== Number(offer.purchase_price_minor)) {
    issues.push({ code: 'PRICE_CHANGED', severity: 'review', message: 'Закупочная цена изменилась после расчёта заказа.' });
  }

  return {
    allowed: !issues.some((issue) => issue.severity === 'block'),
    requiresReview: issues.length > 0,
    issues,
  };
}

export function validateOfferImportRow(row, index = 0) {
  const errors = [];
  const line = index + 2;
  const supplier = String(row.supplier || '').trim();
  const productSku = String(row.product_sku || row.productSku || '').trim();
  const supplierSku = String(row.supplier_sku || row.supplierSku || '').trim();
  let currency = null;
  let purchasePriceMinor = null;

  if (!supplier) errors.push({ line, field: 'supplier', message: 'Не указан поставщик.' });
  if (!productSku) errors.push({ line, field: 'product_sku', message: 'Не указан артикул ONYX.' });
  if (!supplierSku) errors.push({ line, field: 'supplier_sku', message: 'Не указан артикул поставщика.' });

  try { currency = normalizeCurrency(row.currency); } catch (error) { errors.push({ line, field: 'currency', message: error.message }); }
  try { purchasePriceMinor = normalizeMinor(row.purchase_price_minor ?? row.purchasePriceMinor, { allowNull: false, field: 'Закупочная цена' }); }
  catch (error) { errors.push({ line, field: 'purchase_price_minor', message: error.message }); }

  const stockRaw = row.stock_qty ?? row.stockQty;
  const stockQty = stockRaw === '' || stockRaw === null || stockRaw === undefined ? null : Number(stockRaw);
  if (stockQty !== null && (!Number.isSafeInteger(stockQty) || stockQty < 0)) {
    errors.push({ line, field: 'stock_qty', message: 'Остаток должен быть целым неотрицательным числом или пустым.' });
  }

  const stockStatus = String(row.stock_status || row.stockStatus || (stockQty === null ? 'unknown' : stockQty > 0 ? 'in_stock' : 'out_of_stock')).trim();
  if (!['in_stock', 'out_of_stock', 'unknown'].includes(stockStatus)) {
    errors.push({ line, field: 'stock_status', message: 'Допустимо: in_stock, out_of_stock, unknown.' });
  }

  const staleAfterHours = Number(row.stale_after_hours ?? row.staleAfterHours ?? 24);
  if (!Number.isSafeInteger(staleAfterHours) || staleAfterHours < 1 || staleAfterHours > 2160) {
    errors.push({ line, field: 'stale_after_hours', message: 'Срок актуальности должен быть от 1 до 2160 часов.' });
  }

  return {
    errors,
    value: errors.length ? null : {
      supplier,
      productSku,
      supplierSku,
      currency,
      purchasePriceMinor,
      stockQty,
      stockStatus,
      leadTimeDays: row.lead_time_days === '' || row.lead_time_days === undefined ? null : Number(row.lead_time_days),
      staleAfterHours,
    },
  };
}

export function maskContact(value) {
  const contact = String(value || '');
  if (!contact) return '';
  if (contact.includes('@')) {
    const [name, domain] = contact.split('@');
    return `${name.slice(0, 2)}***@${domain || ''}`;
  }
  const digits = contact.replace(/\D/g, '');
  if (digits.length >= 4) return `${contact.slice(0, 2)}***${contact.slice(-2)}`;
  return '***';
}

export function trackingFromOrder(order) {
  const delivery = order.delivery_status;
  const map = {
    not_started: { step: 1, status: 'Заявка принята', location: 'Менеджер ONYX', next: 'Проверка товара и расчёт' },
    preparing: { step: 2, status: 'Товар готовится', location: 'Поставщик', next: 'Подтверждение и отправка на склад' },
    partially_shipped: { step: 3, status: 'Частичная отправка', location: 'Китай', next: 'Ожидаем остальные позиции' },
    shipped: { step: 4, status: 'В пути', location: order.tracking_location || 'Маршрут доставки', next: order.tracking_next || 'Следующее обновление перевозчика' },
    partially_delivered: { step: 4, status: 'Частично доставлен', location: order.tracking_location || 'Страна назначения', next: 'Ожидаем остальные позиции' },
    delivered: { step: 5, status: 'Доставлен', location: order.tracking_location || 'Получатель', next: 'Заказ завершён' },
    not_collected: { step: 4, status: 'Не выкуплен получателем', location: order.tracking_location || 'Пункт выдачи', next: 'Связаться с менеджером' },
    returning: { step: 4, status: 'Возврат в пути', location: order.tracking_location || 'Маршрут возврата', next: 'Приём возврата' },
    returned: { step: 5, status: 'Возвращён', location: order.tracking_location || 'Склад возвратов', next: 'Финансовое закрытие' },
    issue: { step: 3, status: 'Требуется внимание', location: order.tracking_location || 'Уточняется', next: order.tracking_next || 'Менеджер проверяет ситуацию' },
    cancelled: { step: 1, status: 'Отменён', location: 'ONYX GROUP', next: 'Связаться с менеджером при вопросах' },
  };
  const result = map[delivery] || map.not_started;
  return { code: order.public_code, ...result, eta: order.tracking_eta || 'уточняется' };
}
