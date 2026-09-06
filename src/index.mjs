import { adminShell } from './admin-shell.mjs';
import {
  ROLES,
  BUYER_TYPES,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  DELIVERY_STATUSES,
  SUPPLIER_ORDER_STATUSES,
  SHIPMENT_STATUSES,
  assertTransition,
  calculateFinancialSnapshot,
  evaluateSupplierOffer,
  maskContact,
  normalizeCurrency,
  normalizeMinor,
  trackingFromOrder,
  validateOfferImportRow,
} from './ops-core.mjs';
import { detectPlatform, isSafeRemoteUrl } from '../catalog-core.mjs';
import {
  answerTelegramCallback,
  buildTelegramPaymentMessage,
  constantTimeEqual,
  markTelegramPaymentReviewed,
  parseTelegramBindings,
  redactSensitiveText,
  runOnyxAssistant,
  sendTelegramPaymentReview,
} from './assistant-integrations.mjs';

const encoder = new TextEncoder();
const MAX_JSON_BYTES = 1_000_000;
const SESSION_SECONDS = 8 * 60 * 60;
const PASSWORD_ITERATIONS = 120_000;
const ACTIVE_ORDER_STATUSES = "'new','checking','awaiting_payment','supplier_confirmation','processing','partially_shipped','shipped','not_collected','partially_returned','problem'";

class HttpError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function makePublicCode() {
  const date = new Date();
  const ymd = `${String(date.getUTCFullYear()).slice(-2)}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
  const random = crypto.getRandomValues(new Uint32Array(1))[0].toString(36).slice(-4).toUpperCase().padStart(4, '0');
  return `ONYX-${ymd}-${random}`;
}

function cleanText(value, max = 500, { required = false, field = 'Поле' } = {}) {
  const result = String(value ?? '').replace(/\0/g, '').trim();
  if (required && !result) throw new HttpError(422, 'VALIDATION_ERROR', `${field} обязательно.`);
  if (result.length > max) throw new HttpError(422, 'VALIDATION_ERROR', `${field}: не более ${max} символов.`);
  return result;
}

function normalizeContact(value) {
  return cleanText(value, 240, { required: true, field: 'Контакт' }).toLowerCase().replace(/\s+/g, ' ');
}

function normalizeBuyerType(value, fallback = 'consumer') {
  const buyerType = cleanText(value || fallback, 30);
  if (!BUYER_TYPES.includes(buyerType)) throw new HttpError(422, 'INVALID_BUYER_TYPE', 'Тип покупателя должен быть consumer или dropshipper.');
  return buyerType;
}

function normalizeClockTime(value) {
  const time = cleanText(value, 5);
  if (!time) return null;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(422, 'INVALID_TIME', 'Время должно быть в формате ЧЧ:ММ.');
  return time;
}

function parseCookie(request, name) {
  const cookies = request.headers.get('cookie') || '';
  for (const part of cookies.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(value).length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function sha256(value) {
  return base64Url(await crypto.subtle.digest('SHA-256', encoder.encode(String(value))));
}

async function hashPassword(password, saltBytes = crypto.getRandomValues(new Uint8Array(16)), iterations = PASSWORD_ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, key, 256);
  return { salt: base64Url(saltBytes), hash: base64Url(bits), iterations };
}

async function verifyPassword(password, user) {
  const candidate = await hashPassword(password, fromBase64Url(user.password_salt), Number(user.password_iterations));
  const actual = fromBase64Url(user.password_hash);
  const expected = fromBase64Url(candidate.hash);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < actual.length; i += 1) difference |= actual[i] ^ expected[i];
  return difference === 0;
}

async function readJson(request, maxBytes = MAX_JSON_BYTES) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > maxBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Запрос слишком большой.');
  const text = await request.text();
  if (encoder.encode(text).byteLength > maxBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Запрос слишком большой.');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Некорректный JSON.');
  }
}

function dbStatement(env, sql, values = []) {
  if (!env.DB) throw new HttpError(503, 'DATABASE_NOT_CONFIGURED', 'База данных не подключена.');
  return env.DB.prepare(sql).bind(...values);
}

async function dbFirst(env, sql, values = []) {
  return dbStatement(env, sql, values).first();
}

async function dbAll(env, sql, values = []) {
  const result = await dbStatement(env, sql, values).all();
  return result.results || [];
}

async function dbRun(env, sql, values = []) {
  return dbStatement(env, sql, values).run();
}

async function ensurePaymentTelegramRule(env) {
  const timestamp = nowIso();
  await dbRun(env, `INSERT OR IGNORE INTO automation_rules
    (id,name,trigger_event,conditions_json,action_type,mode,enabled,responsible_role,created_at,updated_at)
    VALUES ('rule_payment_telegram_review','Подтверждение оплаты в Telegram','payment.submitted','{}','telegram_payment_review','review',1,'manager',?,?)`,
  [timestamp, timestamp]);
  return dbFirst(env, `SELECT * FROM automation_rules WHERE id='rule_payment_telegram_review'`);
}

function telegramConfigured(env) {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ADMIN_CHAT_ID && env.TELEGRAM_WEBHOOK_SECRET && env.TELEGRAM_ADMIN_BINDINGS);
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || 'https://onyxusx-ai.github.io,http://localhost:8787,http://127.0.0.1:8787')
    .split(',').map((value) => value.trim()).filter(Boolean);
}

export function originAllowed(origin, configured) {
  if (!origin) return true;
  const origins = String(configured || '').split(',').map((value) => value.trim()).filter(Boolean);
  return origins.includes('*') || origins.includes(origin);
}

function responseHeaders(request, env, { cache = 'no-store', contentType = 'application/json; charset=utf-8' } = {}) {
  const headers = new Headers({
    'content-type': contentType,
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  });
  const origin = request.headers.get('origin');
  if (origin && originAllowed(origin, allowedOrigins(env).join(','))) {
    headers.set('access-control-allow-origin', origin);
    headers.set('vary', 'Origin');
    headers.set('access-control-allow-credentials', 'true');
  }
  return headers;
}

function json(request, env, body, status = 200, extraHeaders = {}) {
  const headers = responseHeaders(request, env);
  Object.entries(extraHeaders).forEach(([key, value]) => headers.append(key, value));
  return new Response(JSON.stringify(body), { status, headers });
}

function html(request, env, body, status = 200) {
  const headers = responseHeaders(request, env, { contentType: 'text/html; charset=utf-8' });
  headers.set('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  return new Response(body, { status, headers });
}

function assertAllowedOrigin(request, env) {
  const origin = request.headers.get('origin');
  if (!originAllowed(origin, allowedOrigins(env).join(','))) {
    throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Источник запроса не разрешён.');
  }
}

function assertMethod(request, method) {
  if (request.method !== method) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Метод не поддерживается.');
}

async function getCurrentUser(request, env) {
  const token = parseCookie(request, 'onyx_session');
  if (!token) return null;
  const tokenHash = await sha256(token);
  const user = await dbFirst(env, `
    SELECT u.id, u.email, u.name, u.role, u.is_active, s.expires_at
    FROM staff_sessions s JOIN staff_users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `, [tokenHash]);
  if (!user || Number(user.is_active) !== 1 || new Date(user.expires_at) <= new Date()) {
    if (user) await dbRun(env, 'DELETE FROM staff_sessions WHERE token_hash = ?', [tokenHash]);
    return null;
  }
  await dbRun(env, 'UPDATE staff_sessions SET last_seen_at = ? WHERE token_hash = ?', [nowIso(), tokenHash]);
  return { id: user.id, email: user.email, name: user.name, role: user.role, tokenHash };
}

async function requireUser(request, env, roles = ROLES) {
  const user = await getCurrentUser(request, env);
  if (!user) throw new HttpError(401, 'AUTH_REQUIRED', 'Требуется вход сотрудника.');
  if (!roles.includes(user.role)) throw new HttpError(403, 'FORBIDDEN', 'Недостаточно прав.');
  return user;
}

function legacyAdminAuthorized(request, env) {
  const expected = String(env.ADMIN_TOKEN || '');
  const actual = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return Boolean(expected && actual && expected === actual);
}

async function handleBootstrap(request, env) {
  assertMethod(request, 'POST');
  const setupToken = request.headers.get('x-setup-token') || '';
  if (!env.SETUP_TOKEN || setupToken !== env.SETUP_TOKEN) throw new HttpError(403, 'INVALID_SETUP_TOKEN', 'Неверный токен первичной настройки.');
  const existing = await dbFirst(env, 'SELECT COUNT(*) AS count FROM staff_users');
  if (Number(existing?.count || 0) > 0) throw new HttpError(409, 'ALREADY_BOOTSTRAPPED', 'Первый владелец уже создан.');
  const body = await readJson(request, 20_000);
  const email = cleanText(body.email, 240, { required: true, field: 'Email' }).toLowerCase();
  const name = cleanText(body.name, 120, { required: true, field: 'Имя' });
  const password = cleanText(body.password, 200, { required: true, field: 'Пароль' });
  if (password.length < 12) throw new HttpError(422, 'WEAK_PASSWORD', 'Пароль должен содержать не менее 12 символов.');
  const passwordData = await hashPassword(password);
  const id = makeId('usr');
  const timestamp = nowIso();
  await dbRun(env, `INSERT INTO staff_users
    (id,email,name,role,password_salt,password_hash,password_iterations,is_active,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
  [id, email, name, 'owner', passwordData.salt, passwordData.hash, passwordData.iterations, 1, timestamp, timestamp]);
  await dbRun(env, `INSERT OR IGNORE INTO automation_rules
    (id,name,trigger_event,conditions_json,action_type,mode,enabled,responsible_role,created_at,updated_at)
    VALUES ('rule_order_created_review','Проверка нового заказа','order.created','{}','prepare_manager_review','review',1,'manager',?,?)`,
  [timestamp, timestamp]);
  await ensurePaymentTelegramRule(env);
  return json(request, env, { ok: true, user: { id, email, name, role: 'owner' } }, 201);
}

async function assertLoginAllowed(env, identityHash) {
  const attempt = await dbFirst(env, 'SELECT * FROM login_attempts WHERE identity_hash = ?', [identityHash]);
  if (attempt?.blocked_until && new Date(attempt.blocked_until) > new Date()) {
    throw new HttpError(429, 'LOGIN_BLOCKED', 'Слишком много попыток. Повторите позже.');
  }
}

async function recordLoginFailure(env, identityHash) {
  const timestamp = nowIso();
  const existing = await dbFirst(env, 'SELECT * FROM login_attempts WHERE identity_hash = ?', [identityHash]);
  const windowExpired = !existing || new Date(timestamp) - new Date(existing.window_started_at) > 15 * 60_000;
  const failures = windowExpired ? 1 : Number(existing.failures) + 1;
  const blockedUntil = failures >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
  await dbRun(env, `INSERT INTO login_attempts (identity_hash,failures,window_started_at,blocked_until)
    VALUES (?,?,?,?) ON CONFLICT(identity_hash) DO UPDATE SET failures=excluded.failures,window_started_at=excluded.window_started_at,blocked_until=excluded.blocked_until`,
  [identityHash, failures, windowExpired ? timestamp : existing.window_started_at, blockedUntil]);
}

async function handleLogin(request, env) {
  assertMethod(request, 'POST');
  assertAllowedOrigin(request, env);
  const body = await readJson(request, 20_000);
  const email = cleanText(body.email, 240, { required: true, field: 'Email' }).toLowerCase();
  const password = cleanText(body.password, 200, { required: true, field: 'Пароль' });
  const identityHash = await sha256(email);
  await assertLoginAllowed(env, identityHash);
  const user = await dbFirst(env, 'SELECT * FROM staff_users WHERE email = ?', [email]);
  if (!user || Number(user.is_active) !== 1 || !(await verifyPassword(password, user))) {
    await recordLoginFailure(env, identityHash);
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Неверный email или пароль.');
  }
  await dbRun(env, 'DELETE FROM login_attempts WHERE identity_hash = ?', [identityHash]);
  const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256(token);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  await dbRun(env, 'INSERT INTO staff_sessions (token_hash,user_id,created_at,expires_at,last_seen_at) VALUES (?,?,?,?,?)',
    [tokenHash, user.id, createdAt, expiresAt, createdAt]);
  const cookie = `onyx_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
  return json(request, env, { ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } }, 200, { 'set-cookie': cookie });
}

async function handleLogout(request, env) {
  assertMethod(request, 'POST');
  const user = await getCurrentUser(request, env);
  if (user) await dbRun(env, 'DELETE FROM staff_sessions WHERE token_hash = ?', [user.tokenHash]);
  return json(request, env, { ok: true }, 200, { 'set-cookie': 'onyx_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
}

async function upsertCustomer(env, payload, timestamp, buyerType = 'consumer') {
  const contact = cleanText(payload.customerContact || payload.contact, 240, { required: true, field: 'Контакт клиента' });
  const normalized = normalizeContact(contact);
  const id = makeId('cus');
  await dbRun(env, `INSERT INTO customers
    (id,name,contact,normalized_contact,phone,email,country,city,address,customer_type,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(normalized_contact) DO UPDATE SET
      name=CASE WHEN excluded.name <> '' THEN excluded.name ELSE customers.name END,
      contact=excluded.contact,
      country=CASE WHEN excluded.country <> '' THEN excluded.country ELSE customers.country END,
      city=CASE WHEN excluded.city <> '' THEN excluded.city ELSE customers.city END,
      address=CASE WHEN excluded.address <> '' THEN excluded.address ELSE customers.address END,
      customer_type=CASE WHEN customers.customer_type=excluded.customer_type THEN customers.customer_type ELSE 'both' END,
      updated_at=excluded.updated_at`, [
    id,
    cleanText(payload.customerName || payload.name, 160),
    contact,
    normalized,
    cleanText(payload.phone, 80),
    cleanText(payload.email, 240),
    cleanText(payload.country, 100),
    cleanText(payload.city || payload.customerCity, 120),
    cleanText(payload.address, 500),
    buyerType,
    timestamp,
    timestamp,
  ]);
  return dbFirst(env, 'SELECT * FROM customers WHERE normalized_contact = ?', [normalized]);
}

function publicOrderItems(payload, currency) {
  const items = Array.isArray(payload.items) ? payload.items.slice(0, 100) : [];
  if (!items.length) {
    return [{
      title: cleanText(payload.productTitle || payload.productLink || 'Индивидуальный заказ', 500),
      sku: '',
      variant: cleanText(payload.variant, 300),
      quantity: 1,
      saleUnitMinor: null,
      currency,
    }];
  }
  return items.map((item, index) => {
    const quantity = Number(item.qty ?? item.quantity ?? 1);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10_000) {
      throw new HttpError(422, 'VALIDATION_ERROR', `Некорректное количество в позиции ${index + 1}.`);
    }
    const saleUnitMinor = item.saleUnitMinor !== undefined
      ? normalizeMinor(item.saleUnitMinor)
      : Number.isFinite(Number(item.priceRub)) ? Math.round(Number(item.priceRub) * 100) : null;
    return {
      title: cleanText(item.name || item.title, 500, { required: true, field: `Название позиции ${index + 1}` }),
      sku: cleanText(item.sku, 120),
      variant: cleanText([item.size && `Размер: ${item.size}`, item.color && `Цвет/модель: ${item.color}`].filter(Boolean).join('; ') || item.variant, 300),
      quantity,
      saleUnitMinor,
      currency: normalizeCurrency(item.currency || currency),
    };
  });
}

async function createPublicOrder(request, env, context) {
  assertMethod(request, 'POST');
  assertAllowedOrigin(request, env);
  const payload = await readJson(request, 100_000);
  if (payload.website) return json(request, env, { ok: true, accepted: true }, 202);
  const sourceEventId = cleanText(request.headers.get('idempotency-key') || payload.sourceEventId, 120, { required: true, field: 'Idempotency-Key' });
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(sourceEventId)) throw new HttpError(422, 'INVALID_IDEMPOTENCY_KEY', 'Некорректный ключ защиты от повторов.');

  const duplicate = await dbFirst(env, 'SELECT id, public_code FROM orders WHERE source_event_id = ?', [sourceEventId]);
  if (duplicate) return json(request, env, { ok: true, duplicate: true, order: { id: duplicate.id, code: duplicate.public_code } });

  const timestamp = nowIso();
  const buyerType = normalizeBuyerType(payload.buyerType);
  const customer = await upsertCustomer(env, payload, timestamp, buyerType);
  const currency = normalizeCurrency(payload.saleCurrency || payload.currency || 'RUB');
  const items = publicOrderItems(payload, currency);
  const providedTotal = payload.salesTotalMinor ?? payload.totalMinor;
  const salesTotalMinor = providedTotal !== undefined
    ? normalizeMinor(providedTotal)
    : (Number.isFinite(Number(payload.total)) ? Math.round(Number(payload.total) * 100) : null);
  const orderId = makeId('ord');
  const publicCode = makePublicCode();
  const nextActionAt = new Date(Date.now() + 4 * 60 * 60_000).toISOString();
  const insert = await dbRun(env, `INSERT OR IGNORE INTO orders
    (id,public_code,source,source_event_id,customer_id,buyer_type,order_status,payment_status,delivery_status,comment,sale_currency,sales_total_minor,next_action_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'new','unpaid','not_started',?,?,?,?,?,?)`, [
    orderId,
    publicCode,
    cleanText(payload.source || `site:${payload.type || 'order'}`, 80),
    sourceEventId,
    customer.id,
    buyerType,
    cleanText(payload.message || payload.comment, 4000),
    currency,
    salesTotalMinor,
    nextActionAt,
    timestamp,
    timestamp,
  ]);
  if (Number(insert.meta?.changes || 0) === 0) {
    const existing = await dbFirst(env, 'SELECT id, public_code FROM orders WHERE source_event_id = ?', [sourceEventId]);
    return json(request, env, { ok: true, duplicate: true, order: { id: existing.id, code: existing.public_code } });
  }

  const statements = items.map((item) => env.DB.prepare(`INSERT INTO order_items
    (id,order_id,title,sku,variant_text,quantity,sale_unit_minor,sale_currency,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(makeId('itm'), orderId, item.title, item.sku || null, item.variant || null, item.quantity,
      item.saleUnitMinor, item.currency, timestamp, timestamp));
  statements.push(env.DB.prepare('INSERT INTO order_events (id,order_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?)')
    .bind(makeId('evt'), orderId, 'order_created', JSON.stringify({ source: payload.type || 'site' }), timestamp));
  const reviewRule = await dbFirst(env, `SELECT * FROM automation_rules WHERE id='rule_order_created_review' AND enabled=1`);
  if (reviewRule) {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO automation_jobs
      (id,rule_id,order_id,idempotency_key,action_type,payload_json,status,run_after,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'review',?,?,?)`).bind(makeId('job'), reviewRule.id, orderId, `manager-review:${orderId}`, reviewRule.action_type, '{}', timestamp, timestamp, timestamp));
  }
  await env.DB.batch(statements);

  if (context?.waitUntil) context.waitUntil(Promise.resolve());
  return json(request, env, { ok: true, duplicate: false, order: { id: orderId, code: publicCode } }, 201);
}

function listQueryParams(url) {
  return {
    q: cleanText(url.searchParams.get('q'), 120),
    orderStatus: cleanText(url.searchParams.get('orderStatus'), 40),
    paymentStatus: cleanText(url.searchParams.get('paymentStatus'), 40),
    deliveryStatus: cleanText(url.searchParams.get('deliveryStatus'), 40),
    buyerType: cleanText(url.searchParams.get('buyerType'), 30),
    assignedTo: cleanText(url.searchParams.get('assignedTo'), 80),
    attention: url.searchParams.get('attention') === '1',
  };
}

async function listOrders(request, env, user, url) {
  const filters = listQueryParams(url);
  const clauses = [];
  const values = [];
  if (filters.q) {
    clauses.push('(o.public_code LIKE ? OR c.name LIKE ? OR c.contact LIKE ?)');
    const term = `%${filters.q}%`;
    values.push(term, term, term);
  }
  if (filters.orderStatus) { clauses.push('o.order_status = ?'); values.push(filters.orderStatus); }
  if (filters.paymentStatus) { clauses.push('o.payment_status = ?'); values.push(filters.paymentStatus); }
  if (filters.deliveryStatus) { clauses.push('o.delivery_status = ?'); values.push(filters.deliveryStatus); }
  if (filters.buyerType) { clauses.push('o.buyer_type = ?'); values.push(normalizeBuyerType(filters.buyerType)); }
  if (filters.assignedTo) { clauses.push('o.assigned_to = ?'); values.push(filters.assignedTo); }
  if (filters.attention) { clauses.push(`o.order_status IN (${ACTIVE_ORDER_STATUSES}) AND (o.next_action_at IS NULL OR o.next_action_at < ?)`); values.push(nowIso()); }
  const rows = await dbAll(env, `SELECT o.*, c.name AS customer_name, c.contact AS customer_contact, u.name AS assigned_name
    FROM orders o JOIN customers c ON c.id=o.customer_id
    LEFT JOIN staff_users u ON u.id=o.assigned_to
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY CASE WHEN o.next_action_at < ? THEN 0 ELSE 1 END, o.created_at DESC LIMIT 200`, [...values, nowIso()]);
  const orders = rows.map((row) => ({
    ...row,
    customer_contact: user.role === 'finance' ? maskContact(row.customer_contact) : row.customer_contact,
  }));
  return json(request, env, { ok: true, orders });
}

async function orderDetail(request, env, user, orderId) {
  const order = await dbFirst(env, `SELECT o.*, c.name AS customer_name, c.contact AS customer_contact,
    c.phone AS customer_phone,c.email AS customer_email,c.country AS customer_country,c.city AS customer_city,c.address AS customer_address,
    u.name AS assigned_name
    FROM orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN staff_users u ON u.id=o.assigned_to WHERE o.id=?`, [orderId]);
  if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Заказ не найден.');
  if (user.role === 'finance') {
    order.customer_contact = maskContact(order.customer_contact);
    order.customer_phone = maskContact(order.customer_phone);
    order.customer_email = maskContact(order.customer_email);
    order.customer_address = null;
  }
  const [items, supplierOrders, supplierItems, movements, payments, shipments, events] = await Promise.all([
    dbAll(env, 'SELECT * FROM order_items WHERE order_id=? ORDER BY created_at', [orderId]),
    dbAll(env, `SELECT so.*, s.name AS supplier_name FROM supplier_orders so JOIN suppliers s ON s.id=so.supplier_id
      WHERE so.buyer_order_id=? ORDER BY so.created_at`, [orderId]),
    dbAll(env, `SELECT soi.*, so.buyer_order_id, s.name AS supplier_name, oi.title AS order_item_title
      FROM supplier_order_items soi JOIN supplier_orders so ON so.id=soi.supplier_order_id
      JOIN suppliers s ON s.id=so.supplier_id JOIN order_items oi ON oi.id=soi.order_item_id
      WHERE so.buyer_order_id=? ORDER BY soi.created_at`, [orderId]),
    dbAll(env, 'SELECT * FROM money_movements WHERE order_id=? ORDER BY created_at', [orderId]),
    dbAll(env, `SELECT p.*, u.name AS created_by_name, c.name AS confirmed_by_name,
      t.status AS telegram_status,t.last_error_message AS telegram_error
      FROM payment_records p JOIN staff_users u ON u.id=p.created_by
      LEFT JOIN staff_users c ON c.id=p.confirmed_by
      LEFT JOIN telegram_payment_requests t ON t.payment_id=p.id
      WHERE p.order_id=? ORDER BY p.created_at`, [orderId]),
    dbAll(env, `SELECT sh.*, u.name AS confirmed_by_name FROM shipments sh
      LEFT JOIN staff_users u ON u.id=sh.confirmed_by WHERE sh.order_id=? ORDER BY sh.created_at`, [orderId]),
    dbAll(env, `SELECT e.*, u.name AS actor_name FROM order_events e LEFT JOIN staff_users u ON u.id=e.actor_user_id
      WHERE e.order_id=? ORDER BY e.created_at DESC LIMIT 200`, [orderId]),
  ]);
  return json(request, env, {
    ok: true,
    order,
    items,
    supplierOrders: supplierOrders.map((supplierOrder) => ({
      ...supplierOrder,
      items: supplierItems.filter((item) => item.supplier_order_id === supplierOrder.id),
    })),
    movements,
    payments,
    shipments,
    events,
    finance: calculateFinancialSnapshot(order, movements),
  });
}

async function dashboard(request, env) {
  const timestamp = nowIso();
  const [counts, attention, jobs, offers, orders, movements] = await Promise.all([
    dbFirst(env, `SELECT COUNT(*) AS total,
      SUM(CASE WHEN order_status IN (${ACTIVE_ORDER_STATUSES}) THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN order_status='new' THEN 1 ELSE 0 END) AS new_count,
      SUM(CASE WHEN order_status='problem' THEN 1 ELSE 0 END) AS problem_count
      FROM orders`),
    dbFirst(env, `SELECT COUNT(*) AS count FROM orders WHERE order_status IN (${ACTIVE_ORDER_STATUSES}) AND (next_action_at IS NULL OR next_action_at < ?)`, [timestamp]),
    dbFirst(env, `SELECT SUM(CASE WHEN status IN ('failed','dead') THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status='review' THEN 1 ELSE 0 END) AS review FROM automation_jobs`),
    dbFirst(env, `SELECT COUNT(*) AS stale FROM supplier_offers
      WHERE stock_status!='out_of_stock' AND datetime(last_updated_at, '+' || stale_after_hours || ' hours') < datetime(?)`, [timestamp]),
    dbAll(env, 'SELECT * FROM orders ORDER BY created_at DESC LIMIT 500'),
    dbAll(env, `SELECT * FROM money_movements WHERE order_id IN (SELECT id FROM orders ORDER BY created_at DESC LIMIT 500)`),
  ]);
  const snapshots = orders.map((order) => calculateFinancialSnapshot(order, movements.filter((movement) => movement.order_id === order.id)));
  const knownPreliminary = snapshots.filter((item) => item.preliminaryMarginMinor !== null);
  const preliminaryKnownMinor = snapshots.filter((item) => item.preliminaryMarginMinor !== null).reduce((sum, item) => sum + item.preliminaryMarginMinor, 0);
  const preliminaryUnknown = snapshots.filter((item) => item.preliminaryMarginMinor === null).length;
  const currencySet = [...new Set(snapshots.filter((item) => item.preliminaryMarginMinor !== null).map((item) => item.currency))];
  return json(request, env, {
    ok: true,
    dashboard: {
      orders: { total: Number(counts?.total || 0), active: Number(counts?.active || 0), new: Number(counts?.new_count || 0), problem: Number(counts?.problem_count || 0) },
      attention: Number(attention?.count || 0),
      automation: { failed: Number(jobs?.failed || 0), review: Number(jobs?.review || 0) },
      staleOffers: Number(offers?.stale || 0),
      finance: currencySet.length <= 1 ? {
        preliminaryKnownMinor: knownPreliminary.length ? preliminaryKnownMinor : null,
        currency: currencySet[0] || null,
        preliminaryUnknown,
      } : { preliminaryKnownMinor: null, currency: null, preliminaryUnknown: snapshots.length, note: 'Несколько валют нельзя суммировать без зафиксированного курса.' },
    },
  });
}

function parseStatusPatch(body) {
  const patch = {};
  if (body.orderStatus !== undefined) {
    const value = cleanText(body.orderStatus, 40);
    if (!ORDER_STATUSES.includes(value)) throw new HttpError(422, 'INVALID_STATUS', 'Неизвестный статус заказа.');
    patch.order_status = value;
  }
  if (body.paymentStatus !== undefined) {
    const value = cleanText(body.paymentStatus, 40);
    if (!PAYMENT_STATUSES.includes(value)) throw new HttpError(422, 'INVALID_STATUS', 'Неизвестный статус оплаты.');
    patch.payment_status = value;
  }
  if (body.deliveryStatus !== undefined) {
    const value = cleanText(body.deliveryStatus, 40);
    if (!DELIVERY_STATUSES.includes(value)) throw new HttpError(422, 'INVALID_STATUS', 'Неизвестный статус доставки.');
    patch.delivery_status = value;
  }
  return patch;
}

async function updateOrder(request, env, user, orderId) {
  assertMethod(request, 'PATCH');
  const body = await readJson(request, 50_000);
  const current = await dbFirst(env, 'SELECT * FROM orders WHERE id=?', [orderId]);
  if (!current) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Заказ не найден.');
  const patch = parseStatusPatch(body);
  try {
    if (patch.order_status) assertTransition('order', current.order_status, patch.order_status);
    if (patch.payment_status) assertTransition('payment', current.payment_status, patch.payment_status);
    if (patch.delivery_status) assertTransition('delivery', current.delivery_status, patch.delivery_status);
  } catch (error) {
    throw new HttpError(409, 'INVALID_STATUS_TRANSITION', error.message);
  }
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(patch)) { fields.push(`${key}=?`); values.push(value); }
  if (body.assignedTo !== undefined) {
    const assignee = body.assignedTo ? await dbFirst(env, 'SELECT id FROM staff_users WHERE id=? AND is_active=1', [body.assignedTo]) : null;
    if (body.assignedTo && !assignee) throw new HttpError(422, 'INVALID_ASSIGNEE', 'Ответственный сотрудник не найден.');
    fields.push('assigned_to=?'); values.push(body.assignedTo || null);
  }
  if (body.buyerType !== undefined) { fields.push('buyer_type=?'); values.push(normalizeBuyerType(body.buyerType)); }
  if (body.nextActionAt !== undefined) { fields.push('next_action_at=?'); values.push(body.nextActionAt || null); }
  if (body.priceReviewStatus !== undefined) { fields.push('price_review_status=?'); values.push(cleanText(body.priceReviewStatus, 40)); }
  if (body.stockReviewStatus !== undefined) { fields.push('stock_review_status=?'); values.push(cleanText(body.stockReviewStatus, 40)); }
  if (body.trackingLocation !== undefined) { fields.push('tracking_location=?'); values.push(cleanText(body.trackingLocation, 300) || null); }
  if (body.trackingNext !== undefined) { fields.push('tracking_next=?'); values.push(cleanText(body.trackingNext, 300) || null); }
  if (body.trackingEta !== undefined) { fields.push('tracking_eta=?'); values.push(cleanText(body.trackingEta, 120) || null); }
  if (!fields.length) throw new HttpError(422, 'EMPTY_PATCH', 'Нет изменений.');
  const timestamp = nowIso();
  fields.push('updated_at=?', 'version=version+1'); values.push(timestamp, orderId);
  await dbRun(env, `UPDATE orders SET ${fields.join(',')} WHERE id=?`, values);
  if (body.buyerType !== undefined) {
    await dbRun(env, `UPDATE customers SET customer_type=(
      SELECT CASE WHEN COUNT(DISTINCT buyer_type)>1 THEN 'both' ELSE MAX(buyer_type) END
      FROM orders WHERE customer_id=?
    ),updated_at=? WHERE id=?`, [current.customer_id, timestamp, current.customer_id]);
  }
  await dbRun(env, 'INSERT INTO order_events (id,order_id,actor_user_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?,?)',
    [makeId('evt'), orderId, user.id, 'order_updated', JSON.stringify({ fields: Object.keys(patch)
      .concat(body.assignedTo !== undefined ? ['assigned_to'] : [])
      .concat(body.buyerType !== undefined ? ['buyer_type'] : []) }), timestamp]);
  return orderDetail(request, env, user, orderId);
}

async function createSupplierOrder(request, env, user, orderId) {
  assertMethod(request, 'POST');
  const body = await readJson(request, 100_000);
  const supplierId = cleanText(body.supplierId, 80, { required: true, field: 'Поставщик' });
  const supplier = await dbFirst(env, 'SELECT * FROM suppliers WHERE id=? AND active=1', [supplierId]);
  if (!supplier) throw new HttpError(422, 'SUPPLIER_NOT_FOUND', 'Поставщик не найден или отключён.');
  const order = await dbFirst(env, 'SELECT * FROM orders WHERE id=?', [orderId]);
  if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Заказ не найден.');
  const requestedItems = Array.isArray(body.items) ? body.items : [];
  if (!requestedItems.length) throw new HttpError(422, 'VALIDATION_ERROR', 'Добавьте хотя бы одну позицию поставщику.');
  const prepared = [];
  const allIssues = [];
  for (const requestItem of requestedItems) {
    const item = await dbFirst(env, 'SELECT * FROM order_items WHERE id=? AND order_id=?', [requestItem.orderItemId, orderId]);
    if (!item) throw new HttpError(422, 'ORDER_ITEM_NOT_FOUND', 'Позиция заказа не найдена.');
    const offer = await dbFirst(env, 'SELECT * FROM supplier_offers WHERE id=? AND supplier_id=?', [requestItem.supplierOfferId, supplierId]);
    const check = evaluateSupplierOffer(offer, {
      quantity: requestItem.quantity,
      expectedPurchaseUnitMinor: requestItem.expectedPurchaseUnitMinor,
    });
    const allocated = await dbFirst(env, `SELECT COALESCE(SUM(soi.quantity),0) AS quantity
      FROM supplier_order_items soi JOIN supplier_orders so ON so.id=soi.supplier_order_id
      WHERE soi.order_item_id=? AND so.status NOT IN ('cancelled','returned')`, [item.id]);
    if (Number(allocated?.quantity || 0) + Number(requestItem.quantity || 0) > Number(item.quantity)) {
      check.issues.push({ code: 'OVER_ALLOCATED', severity: 'block', message: 'Распределено больше количества в заказе покупателя.' });
      check.allowed = false;
      check.requiresReview = true;
    }
    allIssues.push(...check.issues.map((issue) => ({ ...issue, orderItemId: item.id })));
    prepared.push({ item, offer, quantity: Number(requestItem.quantity), check });
  }
  if (allIssues.some((issue) => issue.severity === 'block') || (allIssues.length && body.confirmReview !== true)) {
    throw new HttpError(409, 'SUPPLIER_REVIEW_REQUIRED', 'Перед созданием заказа поставщику нужна проверка.', { issues: allIssues });
  }
  const currencies = [...new Set(prepared.map(({ offer }) => offer.currency))];
  if (currencies.length !== 1) throw new HttpError(422, 'MIXED_SUPPLIER_CURRENCIES', 'Один заказ поставщику должен быть в одной валюте.');
  const timestamp = nowIso();
  const supplierOrderId = makeId('spo');
  const total = prepared.reduce((sum, row) => sum + Number(row.offer.purchase_price_minor) * row.quantity, 0);
  const statements = [env.DB.prepare(`INSERT INTO supplier_orders
    (id,buyer_order_id,supplier_id,status,purchase_total_minor,purchase_currency,created_at,updated_at)
    VALUES (?,?,?,'draft',?,?,?,?)`).bind(supplierOrderId, orderId, supplierId, total, currencies[0], timestamp, timestamp)];
  for (const row of prepared) {
    statements.push(env.DB.prepare(`INSERT INTO supplier_order_items
      (id,supplier_order_id,order_item_id,quantity,purchase_unit_minor,currency,created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(makeId('spi'), supplierOrderId, row.item.id, row.quantity, row.offer.purchase_price_minor, row.offer.currency, timestamp));
    statements.push(env.DB.prepare(`UPDATE order_items SET purchase_snapshot_minor=?,purchase_currency=?,supplier_offer_id=?,updated_at=? WHERE id=?`)
      .bind(row.offer.purchase_price_minor, row.offer.currency, row.offer.id, timestamp, row.item.id));
  }
  statements.push(env.DB.prepare('INSERT INTO order_events (id,order_id,actor_user_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?,?)')
    .bind(makeId('evt'), orderId, user.id, 'supplier_order_created', JSON.stringify({ supplierOrderId, issueCodes: allIssues.map((issue) => issue.code) }), timestamp));
  await env.DB.batch(statements);
  return json(request, env, { ok: true, supplierOrderId, reviewAccepted: allIssues.length > 0 }, 201);
}

async function createMoneyMovement(request, env, user, orderId) {
  assertMethod(request, 'POST');
  const body = await readJson(request, 30_000);
  const order = await dbFirst(env, 'SELECT * FROM orders WHERE id=?', [orderId]);
  if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Заказ не найден.');
  const direction = cleanText(body.direction, 10);
  const category = cleanText(body.category, 30);
  const status = cleanText(body.status, 20);
  if (!['in', 'out'].includes(direction)) throw new HttpError(422, 'VALIDATION_ERROR', 'Некорректное направление движения денег.');
  if (!['revenue', 'purchase', 'delivery', 'fee', 'discount', 'refund', 'tax', 'other'].includes(category)) throw new HttpError(422, 'VALIDATION_ERROR', 'Некорректная категория движения денег.');
  if (!['planned', 'actual'].includes(status)) throw new HttpError(422, 'VALIDATION_ERROR', 'Некорректный тип движения денег.');
  const amountMinor = normalizeMinor(body.amountMinor, { allowNull: false });
  if (amountMinor < 0) throw new HttpError(422, 'VALIDATION_ERROR', 'Сумма не может быть отрицательной.');
  const currency = normalizeCurrency(body.currency || order.sale_currency);
  const externalEventId = cleanText(body.externalEventId, 120) || null;
  if (externalEventId) {
    const duplicate = await dbFirst(env, 'SELECT id FROM money_movements WHERE category=? AND external_event_id=?', [category, externalEventId]);
    if (duplicate) return json(request, env, { ok: true, duplicate: true, movementId: duplicate.id });
  }
  const timestamp = nowIso();
  const movementId = makeId('mov');
  await dbRun(env, `INSERT INTO money_movements
    (id,order_id,supplier_order_id,direction,category,status,amount_minor,currency,occurred_at,note,external_event_id,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [movementId, orderId, body.supplierOrderId || null, direction, category, status, amountMinor,
    currency, body.occurredAt || (status === 'actual' ? timestamp : null), cleanText(body.note, 1000) || null, externalEventId, user.id, timestamp]);
  if (category === 'refund' && direction === 'out') {
    const next = body.final === true ? 'refunded' : 'partially_refunded';
    try { assertTransition('payment', order.payment_status, next); }
    catch (error) { throw new HttpError(409, 'INVALID_STATUS_TRANSITION', error.message); }
    await dbRun(env, 'UPDATE orders SET payment_status=?,updated_at=?,version=version+1 WHERE id=?', [next, timestamp, orderId]);
  }
  if (body.costsComplete !== undefined) {
    await dbRun(env, 'UPDATE orders SET costs_complete=?,updated_at=?,version=version+1 WHERE id=?', [body.costsComplete ? 1 : 0, timestamp, orderId]);
  }
  await dbRun(env, 'INSERT INTO order_events (id,order_id,actor_user_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?,?)',
    [makeId('evt'), orderId, user.id, 'money_movement_recorded', JSON.stringify({ movementId, direction, category, status, currency }), timestamp]);
  return json(request, env, { ok: true, movementId }, 201);
}

async function createPaymentRecord(request, env, user, orderId) {
  assertMethod(request, 'POST');
  const body = await readJson(request, 30_000);
  const order = await dbFirst(env, 'SELECT * FROM orders WHERE id=?', [orderId]);
  if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Заказ не найден.');
  const idempotencyKey = cleanText(request.headers.get('idempotency-key') || body.idempotencyKey, 120,
    { required: true, field: 'Idempotency-Key' });
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(idempotencyKey)) throw new HttpError(422, 'INVALID_IDEMPOTENCY_KEY', 'Некорректный ключ защиты от повторов.');
  const duplicate = await dbFirst(env, 'SELECT id,status FROM payment_records WHERE idempotency_key=?', [idempotencyKey]);
  if (duplicate) return json(request, env, { ok: true, duplicate: true, payment: duplicate });
  const method = cleanText(body.method, 40);
  if (!['bank_transfer', 'payment_provider', 'cash', 'other'].includes(method)) {
    throw new HttpError(422, 'INVALID_PAYMENT_METHOD', 'Для пилота доступны перевод, платёжный провайдер, наличные или другой ручной способ.');
  }
  const expectedAmountMinor = normalizeMinor(body.expectedAmountMinor, { allowNull: false, field: 'Ожидаемая сумма' });
  if (expectedAmountMinor < 0) throw new HttpError(422, 'VALIDATION_ERROR', 'Сумма не может быть отрицательной.');
  const currency = normalizeCurrency(body.currency || order.sale_currency);
  if (currency !== order.sale_currency) throw new HttpError(409, 'PAYMENT_CURRENCY_MISMATCH', 'В пилоте платёж должен быть в валюте заказа.');
  const timestamp = nowIso();
  const paymentId = makeId('pay');
  const nextPaymentStatus = ['unpaid', 'failed'].includes(order.payment_status) ? 'pending' : order.payment_status;
  const telegramRule = await ensurePaymentTelegramRule(env);
  const statements = [
    env.DB.prepare(`INSERT INTO payment_records
      (id,order_id,idempotency_key,method,status,expected_amount_minor,currency,provider,external_reference,note,created_by,created_at,updated_at)
      VALUES (?,?,?,?,'pending_verification',?,?,?,?,?,?,?,?)`).bind(paymentId, orderId, idempotencyKey, method,
      expectedAmountMinor, currency, cleanText(body.provider, 120) || null, cleanText(body.externalReference, 200) || null,
      cleanText(body.note, 1000) || null, user.id, timestamp, timestamp),
    env.DB.prepare('UPDATE orders SET payment_status=?,updated_at=?,version=version+1 WHERE id=?')
      .bind(nextPaymentStatus, timestamp, orderId),
    env.DB.prepare('INSERT INTO order_events (id,order_id,actor_user_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?,?)')
      .bind(makeId('evt'), orderId, user.id, 'payment_submitted_for_review', JSON.stringify({ paymentId, method, currency }), timestamp),
  ];
  if (Number(telegramRule?.enabled) === 1) {
    const jobId = makeId('job');
    const requestId = makeId('tpr');
    const jobStatus = telegramRule.mode === 'live' ? 'pending' : 'review';
    statements.push(
      env.DB.prepare(`INSERT INTO automation_jobs
        (id,rule_id,order_id,idempotency_key,action_type,payload_json,status,run_after,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?, ?,?,?)`).bind(jobId, telegramRule.id, orderId, `telegram-payment:${paymentId}`,
        'telegram_payment_review', JSON.stringify({ paymentId }), jobStatus, timestamp, timestamp, timestamp),
      env.DB.prepare(`INSERT INTO telegram_payment_requests
        (id,payment_id,job_id,status,created_at,updated_at) VALUES (?,?,?,'prepared',?,?)`)
        .bind(requestId, paymentId, jobId, timestamp, timestamp),
    );
  }
  await env.DB.batch(statements);
  return json(request, env, { ok: true, duplicate: false, payment: { id: paymentId, status: 'pending_verification' } }, 201);
}

async function reviewPaymentRecord(request, env, user, paymentId) {
  assertMethod(request, 'PATCH');
  const body = await readJson(request, 20_000);
  const payment = await dbFirst(env, 'SELECT * FROM payment_records WHERE id=?', [paymentId]);
  if (!payment) throw new HttpError(404, 'PAYMENT_NOT_FOUND', 'Платёж не найден.');
  const action = cleanText(body.action, 20, { required: true, field: 'Действие' });
  const target = action === 'confirm' ? 'confirmed' : action === 'reject' ? 'rejected' : action === 'cancel' ? 'cancelled' : null;
  if (!target) throw new HttpError(422, 'INVALID_PAYMENT_ACTION', 'Доступно подтверждение, отклонение или отмена.');
  if (payment.status === target) return json(request, env, { ok: true, duplicate: true, payment: { id: payment.id, status: target } });
  if (payment.status !== 'pending_verification') throw new HttpError(409, 'PAYMENT_ALREADY_REVIEWED', 'Платёж уже обработан.');
  const order = await dbFirst(env, 'SELECT * FROM orders WHERE id=?', [payment.order_id]);
  const timestamp = nowIso();
  if (target !== 'confirmed') {
    const pending = await dbFirst(env, `SELECT COUNT(*) AS count FROM payment_records
      WHERE order_id=? AND status='pending_verification' AND id<>?`, [payment.order_id, payment.id]);
    const nextStatus = Number(pending?.count || 0) ? order.payment_status : (order.payment_status === 'pending' ? 'failed' : order.payment_status);
    await env.DB.batch([
      env.DB.prepare('UPDATE payment_records SET status=?,confirmed_by=?,confirmed_at=?,updated_at=? WHERE id=?')
        .bind(target, user.id, timestamp, timestamp, payment.id),
      env.DB.prepare('UPDATE orders SET payment_status=?,updated_at=?,version=version+1 WHERE id=?')
        .bind(nextStatus, timestamp, payment.order_id),
      env.DB.prepare('INSERT INTO order_events (id,order_id,actor_user_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?,?)')
        .bind(makeId('evt'), payment.order_id, user.id, 'payment_reviewed', JSON.stringify({ paymentId, status: target }), timestamp),
    ]);
    return json(request, env, { ok: true, duplicate: false, payment: { id: payment.id, status: target } });
  }

  const receivedAmountMinor = normalizeMinor(body.receivedAmountMinor ?? payment.expected_amount_minor,
    { allowNull: false, field: 'Полученная сумма' });
  if (receivedAmountMinor < 0) throw new HttpError(422, 'VALIDATION_ERROR', 'Сумма не может быть отрицательной.');
  const confirmed = await dbFirst(env, `SELECT COALESCE(SUM(received_amount_minor),0) AS total
    FROM payment_records WHERE order_id=? AND status='confirmed' AND currency=?`, [payment.order_id, payment.currency]);
  const confirmedTotal = Number(confirmed?.total || 0) + receivedAmountMinor;
  const nextStatus = order.sales_total_minor !== null && confirmedTotal >= Number(order.sales_total_minor) ? 'paid' : 'partially_paid';
  try { assertTransition('payment', order.payment_status, nextStatus); }
  catch (error) { throw new HttpError(409, 'INVALID_STATUS_TRANSITION', error.message); }
  const movementId = makeId('mov');
  await env.DB.batch([
    env.DB.prepare(`UPDATE payment_records SET status='confirmed',received_amount_minor=?,provider=?,external_reference=?,
      confirmed_by=?,confirmed_at=?,updated_at=? WHERE id=?`).bind(receivedAmountMinor,
      cleanText(body.provider, 120) || payment.provider, cleanText(body.externalReference, 200) || payment.external_reference,
      user.id, timestamp, timestamp, payment.id),
    env.DB.prepare(`INSERT OR IGNORE INTO money_movements
      (id,order_id,direction,category,status,amount_minor,currency,occurred_at,note,external_event_id,created_by,created_at)
      VALUES (?,?,'in','revenue','actual',?,?,?,?,?,?,?)`).bind(movementId, payment.order_id, receivedAmountMinor,
      payment.currency, timestamp, 'Подтверждённый платёж', `payment:${payment.id}`, user.id, timestamp),
    env.DB.prepare('UPDATE orders SET payment_status=?,updated_at=?,version=version+1 WHERE id=?')
      .bind(nextStatus, timestamp, payment.order_id),
    env.DB.prepare('INSERT INTO order_events (id,order_id,actor_user_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?,?)')
      .bind(makeId('evt'), payment.order_id, user.id, 'payment_confirmed', JSON.stringify({ paymentId, amountMinor: receivedAmountMinor, currency: payment.currency }), timestamp),
  ]);
  return json(request, env, { ok: true, duplicate: false, payment: { id: payment.id, status: 'confirmed' }, orderPaymentStatus: nextStatus }, 200);
}

async function createShipment(request, env, user, orderId) {
  assertMethod(request, 'POST');
  const body = await readJson(request, 20_000);
  const order = await dbFirst(env, 'SELECT id FROM orders WHERE id=?', [orderId]);
  if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Заказ не найден.');
  const idempotencyKey = cleanText(request.headers.get('idempotency-key') || body.idempotencyKey, 120,
    { required: true, field: 'Idempotency-Key' });
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(idempotencyKey)) throw new HttpError(422, 'INVALID_IDEMPOTENCY_KEY', 'Некорректный ключ защиты от повторов.');
  const duplicate = await dbFirst(env, 'SELECT id,status FROM shipments WHERE idempotency_key=?', [idempotencyKey]);
  if (duplicate) return json(request, env, { ok: true, duplicate: true, shipment: duplicate });
  const pieces = Number(body.pieces || 1);
  if (!Number.isSafeInteger(pieces) || pieces < 1) throw new HttpError(422, 'VALIDATION_ERROR', 'Количество мест должно быть целым положительным числом.');
  const timestamp = nowIso();
  const shipmentId = makeId('shp');
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO shipments
      (id,order_id,idempotency_key,cargo_name,status,tracking_code,pieces,note,created_at,updated_at)
      VALUES (?,?,?,?,'pending_confirmation',?,?,?,?,?)`).bind(shipmentId, orderId, idempotencyKey,
      cleanText(body.cargoName, 160, { required: true, field: 'Карго' }), cleanText(body.trackingCode, 200) || null,
      pieces, cleanText(body.note, 1000) || null, timestamp, timestamp),
    env.DB.prepare('INSERT INTO order_events (id,order_id,actor_user_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?,?)')
      .bind(makeId('evt'), orderId, user.id, 'shipment_submitted_for_confirmation', JSON.stringify({ shipmentId }), timestamp),
  ]);
  return json(request, env, { ok: true, duplicate: false, shipment: { id: shipmentId, status: 'pending_confirmation' } }, 201);
}

async function updateShipment(request, env, user, shipmentId) {
  assertMethod(request, 'PATCH');
  const body = await readJson(request, 20_000);
  const shipment = await dbFirst(env, 'SELECT * FROM shipments WHERE id=?', [shipmentId]);
  if (!shipment) throw new HttpError(404, 'SHIPMENT_NOT_FOUND', 'Отправление не найдено.');
  const status = cleanText(body.status, 40, { required: true, field: 'Статус отправления' });
  if (!SHIPMENT_STATUSES.includes(status)) throw new HttpError(422, 'INVALID_STATUS', 'Неизвестный статус отправления.');
  try { assertTransition('shipment', shipment.status, status); }
  catch (error) { throw new HttpError(409, 'INVALID_STATUS_TRANSITION', error.message); }
  const order = await dbFirst(env, 'SELECT * FROM orders WHERE id=?', [shipment.order_id]);
  const deliveryMap = { confirmed: 'preparing', partially_shipped: 'partially_shipped', shipped: 'shipped', delivered: 'delivered', not_collected: 'not_collected', returning: 'returning', returned: 'returned', issue: 'issue', cancelled: 'cancelled' };
  const requestedDelivery = deliveryMap[status];
  let nextDelivery = order.delivery_status;
  if (requestedDelivery) {
    try { assertTransition('delivery', order.delivery_status, requestedDelivery); nextDelivery = requestedDelivery; }
    catch { nextDelivery = order.delivery_status; }
  }
  const timestamp = nowIso();
  await env.DB.batch([
    env.DB.prepare(`UPDATE shipments SET status=?,tracking_code=?,confirmed_by=?,confirmed_at=COALESCE(confirmed_at,?),updated_at=? WHERE id=?`)
      .bind(status, cleanText(body.trackingCode, 200) || shipment.tracking_code, user.id, timestamp, timestamp, shipment.id),
    env.DB.prepare(`UPDATE orders SET delivery_status=?,tracking_location=?,updated_at=?,version=version+1 WHERE id=?`)
      .bind(nextDelivery, cleanText(body.location, 300) || order.tracking_location, timestamp, shipment.order_id),
    env.DB.prepare('INSERT INTO order_events (id,order_id,actor_user_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?,?)')
      .bind(makeId('evt'), shipment.order_id, user.id, 'shipment_confirmed', JSON.stringify({ shipmentId, status, deliveryStatus: nextDelivery }), timestamp),
  ]);
  return json(request, env, { ok: true, shipment: { id: shipment.id, status }, deliveryStatus: nextDelivery });
}

async function updateOrderFinance(request, env, user, orderId) {
  assertMethod(request, 'PATCH');
  const body = await readJson(request, 30_000);
  const order = await dbFirst(env, 'SELECT * FROM orders WHERE id=?', [orderId]);
  if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Заказ не найден.');
  const mapping = {
    salesTotalMinor: 'sales_total_minor',
    discountMinor: 'discount_minor',
    purchaseEstimateMinor: 'purchase_estimate_minor',
    deliveryCostEstimateMinor: 'delivery_cost_estimate_minor',
    commissionCostEstimateMinor: 'commission_cost_estimate_minor',
  };
  const fields = [];
  const values = [];
  for (const [input, column] of Object.entries(mapping)) {
    if (body[input] !== undefined) {
      const value = normalizeMinor(body[input], { allowNull: input !== 'discountMinor', field: input });
      if (value !== null && value < 0) throw new HttpError(422, 'VALIDATION_ERROR', 'Финансовая сумма не может быть отрицательной.');
      fields.push(`${column}=?`);
      values.push(value);
    }
  }
  if (body.costsComplete !== undefined) { fields.push('costs_complete=?'); values.push(body.costsComplete ? 1 : 0); }
  if (!fields.length) throw new HttpError(422, 'EMPTY_PATCH', 'Нет финансовых изменений.');
  const timestamp = nowIso();
  fields.push('updated_at=?', 'version=version+1');
  values.push(timestamp, orderId);
  await dbRun(env, `UPDATE orders SET ${fields.join(',')} WHERE id=?`, values);
  await dbRun(env, 'INSERT INTO order_events (id,order_id,actor_user_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?,?)',
    [makeId('evt'), orderId, user.id, 'finance_estimate_updated', JSON.stringify({ fields: Object.keys(body).filter((key) => key !== 'note') }), timestamp]);
  return orderDetail(request, env, user, orderId);
}

async function updateSupplierOrder(request, env, user, supplierOrderId) {
  assertMethod(request, 'PATCH');
  const body = await readJson(request, 20_000);
  const current = await dbFirst(env, 'SELECT * FROM supplier_orders WHERE id=?', [supplierOrderId]);
  if (!current) throw new HttpError(404, 'SUPPLIER_ORDER_NOT_FOUND', 'Заказ поставщику не найден.');
  const status = cleanText(body.status, 40, { required: true, field: 'Статус заказа поставщику' });
  if (!SUPPLIER_ORDER_STATUSES.includes(status)) throw new HttpError(422, 'INVALID_STATUS', 'Неизвестный статус заказа поставщику.');
  try { assertTransition('supplier_order', current.status, status); }
  catch (error) { throw new HttpError(409, 'INVALID_STATUS_TRANSITION', error.message); }
  const timestamp = nowIso();
  await dbRun(env, `UPDATE supplier_orders SET status=?,supplier_reference=?,tracking_code=?,
    confirmed_at=CASE WHEN ?='confirmed' AND confirmed_at IS NULL THEN ? ELSE confirmed_at END,
    shipped_at=CASE WHEN ? IN ('partially_shipped','shipped') AND shipped_at IS NULL THEN ? ELSE shipped_at END,
    updated_at=? WHERE id=?`, [status, cleanText(body.supplierReference, 200) || current.supplier_reference,
    cleanText(body.trackingCode, 200) || current.tracking_code, status, timestamp, status, timestamp, timestamp, supplierOrderId]);
  await dbRun(env, 'INSERT INTO order_events (id,order_id,actor_user_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?,?)',
    [makeId('evt'), current.buyer_order_id, user.id, 'supplier_order_updated', JSON.stringify({ supplierOrderId, status }), timestamp]);
  return json(request, env, { ok: true, supplierOrderId, status });
}

async function createStaff(request, env) {
  assertMethod(request, 'POST');
  const body = await readJson(request, 20_000);
  const email = cleanText(body.email, 240, { required: true, field: 'Email' }).toLowerCase();
  const name = cleanText(body.name, 120, { required: true, field: 'Имя' });
  const role = cleanText(body.role, 20);
  if (!ROLES.includes(role)) throw new HttpError(422, 'VALIDATION_ERROR', 'Неизвестная роль.');
  const password = cleanText(body.password, 200, { required: true, field: 'Пароль' });
  if (password.length < 12) throw new HttpError(422, 'WEAK_PASSWORD', 'Пароль должен содержать не менее 12 символов.');
  const passwordData = await hashPassword(password);
  const id = makeId('usr');
  const timestamp = nowIso();
  await dbRun(env, `INSERT INTO staff_users
    (id,email,name,role,password_salt,password_hash,password_iterations,is_active,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [id, email, name, role, passwordData.salt, passwordData.hash, passwordData.iterations, 1, timestamp, timestamp]);
  return json(request, env, { ok: true, user: { id, email, name, role } }, 201);
}

async function listStaff(request, env) {
  const staff = await dbAll(env, 'SELECT id,email,name,role,is_active,created_at FROM staff_users ORDER BY name');
  return json(request, env, { ok: true, staff });
}

async function createSupplier(request, env) {
  assertMethod(request, 'POST');
  const body = await readJson(request, 30_000);
  const id = makeId('sup');
  const name = cleanText(body.name, 200, { required: true, field: 'Название поставщика' });
  const currency = body.defaultCurrency ? normalizeCurrency(body.defaultCurrency) : null;
  const timestamp = nowIso();
  await dbRun(env, `INSERT INTO suppliers
    (id,name,channel,contact,default_currency,terms,contact_timezone,contact_window_start,contact_window_end,active,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`, [id, name, cleanText(body.channel || 'manual', 60), cleanText(body.contact, 300) || null,
    currency, cleanText(body.terms, 2000) || null, cleanText(body.contactTimezone || 'Asia/Shanghai', 80),
    normalizeClockTime(body.contactWindowStart), normalizeClockTime(body.contactWindowEnd), timestamp, timestamp]);
  return json(request, env, { ok: true, supplier: { id, name, default_currency: currency } }, 201);
}

async function listSuppliers(request, env) {
  const suppliers = await dbAll(env, `SELECT s.*,
    COUNT(so.id) AS offer_count,
    SUM(CASE WHEN so.stock_status='unknown' OR datetime(so.last_updated_at, '+' || so.stale_after_hours || ' hours') < datetime(?) THEN 1 ELSE 0 END) AS attention_offers
    FROM suppliers s LEFT JOIN supplier_offers so ON so.supplier_id=s.id GROUP BY s.id ORDER BY s.name`, [nowIso()]);
  return json(request, env, { ok: true, suppliers });
}

async function createProduct(request, env) {
  assertMethod(request, 'POST');
  const body = await readJson(request, 50_000);
  const id = makeId('prd');
  const variantId = makeId('var');
  const sku = cleanText(body.sku, 120, { required: true, field: 'Артикул' });
  const name = cleanText(body.name, 500, { required: true, field: 'Название товара' });
  const timestamp = nowIso();
  const currency = body.saleCurrency ? normalizeCurrency(body.saleCurrency) : null;
  const salePriceMinor = normalizeMinor(body.salePriceMinor);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO products
      (id,sku,name,category,description,platform,source_url,sale_price_minor,sale_currency,min_margin_bps,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?)`).bind(id, sku, name, cleanText(body.category, 120) || null, cleanText(body.description, 4000) || null,
      cleanText(body.platform, 80) || null, cleanText(body.sourceUrl, 1000) || null, salePriceMinor, currency,
      body.minMarginBps === undefined ? null : normalizeMinor(body.minMarginBps), 'active', timestamp, timestamp),
    env.DB.prepare(`INSERT INTO product_variants (id,product_id,sku,name,attributes_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(variantId, id, sku, cleanText(body.variantName, 200) || 'Основной вариант', JSON.stringify(body.attributes || {}), timestamp, timestamp),
  ]);
  return json(request, env, { ok: true, product: { id, sku, name, variantId } }, 201);
}

async function listProductsAdmin(request, env) {
  const products = await dbAll(env, `SELECT p.*, pv.id AS variant_id,pv.sku AS variant_sku,
    COUNT(so.id) AS offer_count,MAX(so.last_updated_at) AS last_offer_update
    FROM products p JOIN product_variants pv ON pv.product_id=p.id
    LEFT JOIN supplier_offers so ON so.variant_id=pv.id GROUP BY p.id,pv.id ORDER BY p.updated_at DESC`);
  return json(request, env, { ok: true, products });
}

async function listOffers(request, env) {
  const offers = await dbAll(env, `SELECT so.*,s.name AS supplier_name,p.name AS product_name,p.sku AS product_sku,pv.sku AS variant_sku
    FROM supplier_offers so JOIN suppliers s ON s.id=so.supplier_id
    JOIN product_variants pv ON pv.id=so.variant_id JOIN products p ON p.id=pv.product_id
    ORDER BY s.name,p.name`);
  return json(request, env, { ok: true, offers });
}

async function importOffers(request, env) {
  assertMethod(request, 'POST');
  const body = await readJson(request, 800_000);
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 5_000) : [];
  if (!rows.length) throw new HttpError(422, 'VALIDATION_ERROR', 'Нет строк для проверки.');
  const validations = rows.map((row, index) => validateOfferImportRow(row, index));
  const errors = validations.flatMap((item) => item.errors);
  const normalized = validations.map((item) => item.value).filter(Boolean);
  for (let index = 0; index < normalized.length; index += 1) {
    const row = normalized[index];
    const variant = await dbFirst(env, 'SELECT id FROM product_variants WHERE sku=?', [row.productSku]);
    if (!variant) errors.push({ line: index + 2, field: 'product_sku', message: `Артикул ONYX ${row.productSku} не найден.` });
  }
  if (body.commit !== true || errors.length) {
    return json(request, env, { ok: errors.length === 0, preview: true, validRows: normalized.length - errors.filter((error) => error.field === 'product_sku').length, errors }, errors.length ? 422 : 200);
  }
  const timestamp = nowIso();
  let imported = 0;
  for (const row of normalized) {
    let supplier = await dbFirst(env, 'SELECT id FROM suppliers WHERE name=? COLLATE NOCASE', [row.supplier]);
    if (!supplier) {
      const supplierId = makeId('sup');
      await dbRun(env, `INSERT INTO suppliers (id,name,channel,default_currency,active,created_at,updated_at) VALUES (?,?, 'csv',?,1,?,?)`,
        [supplierId, row.supplier, row.currency, timestamp, timestamp]);
      supplier = { id: supplierId };
    }
    const variant = await dbFirst(env, 'SELECT id FROM product_variants WHERE sku=?', [row.productSku]);
    await dbRun(env, `INSERT INTO supplier_offers
      (id,supplier_id,variant_id,supplier_sku,purchase_price_minor,currency,stock_qty,stock_status,lead_time_days,last_updated_at,stale_after_hours,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(supplier_id,supplier_sku) DO UPDATE SET variant_id=excluded.variant_id,purchase_price_minor=excluded.purchase_price_minor,
      currency=excluded.currency,stock_qty=excluded.stock_qty,stock_status=excluded.stock_status,lead_time_days=excluded.lead_time_days,
      last_updated_at=excluded.last_updated_at,stale_after_hours=excluded.stale_after_hours,updated_at=excluded.updated_at`,
    [makeId('off'), supplier.id, variant.id, row.supplierSku, row.purchasePriceMinor, row.currency, row.stockQty, row.stockStatus,
      row.leadTimeDays, timestamp, row.staleAfterHours, timestamp, timestamp]);
    imported += 1;
  }
  return json(request, env, { ok: true, preview: false, imported, errors: [] }, 201);
}

async function integrationStatus(request, env) {
  const rule = await ensurePaymentTelegramRule(env);
  return json(request, env, {
    ok: true,
    integrations: {
      ai: { configured: Boolean(env.OPENAI_API_KEY && env.OPENAI_MODEL), model: env.OPENAI_MODEL || null },
      telegram: { configured: telegramConfigured(env), mode: rule?.mode || 'review', enabled: Number(rule?.enabled) === 1 },
    },
  });
}

async function assistantForOrder(request, env, user, orderId) {
  assertMethod(request, 'POST');
  const body = await readJson(request, 20_000);
  const order = await dbFirst(env, `SELECT id,public_code,buyer_type,order_status,payment_status,delivery_status,
    sale_currency,sales_total_minor,purchase_estimate_minor,delivery_cost_estimate_minor,commission_cost_estimate_minor,costs_complete
    FROM orders WHERE id=?`, [orderId]);
  if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Заказ не найден.');
  const [items, supplierOrders] = await Promise.all([
    dbAll(env, 'SELECT title,sku,variant_text,quantity,sale_unit_minor,sale_currency FROM order_items WHERE order_id=? ORDER BY created_at', [orderId]),
    dbAll(env, `SELECT s.name AS supplier_name,so.status,so.purchase_total_minor,so.purchase_currency
      FROM supplier_orders so JOIN suppliers s ON s.id=so.supplier_id WHERE so.buyer_order_id=? ORDER BY so.created_at`, [orderId]),
  ]);
  const purpose = cleanText(body.purpose, 40, { required: true, field: 'Задача помощника' });
  const input = redactSensitiveText(cleanText(body.input, 4000, { required: true, field: 'Сообщение для помощника' }), 4000);
  const runId = makeId('air');
  const timestamp = nowIso();
  const inputHash = await sha256(input);
  const orderContext = { ...order, items, supplierOrders };
  try {
    const result = await runOnyxAssistant(env, { purpose, input, orderContext });
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO ai_runs
        (id,order_id,staff_user_id,purpose,input_hash,input_preview,output_text,model,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,'completed',?)`).bind(runId, orderId, user.id, purpose, inputHash,
        input.slice(0, 300), result.output, result.model, timestamp),
      env.DB.prepare('INSERT INTO order_events (id,order_id,actor_user_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?,?)')
        .bind(makeId('evt'), orderId, user.id, 'ai_assistant_completed', JSON.stringify({ runId, purpose, model: result.model }), timestamp),
    ]);
    return json(request, env, { ok: true, assistant: { runId, purpose, output: result.output, model: result.model } });
  } catch (error) {
    const errorCode = cleanText(error.code || 'AI_FAILED', 80);
    await dbRun(env, `INSERT INTO ai_runs
      (id,order_id,staff_user_id,purpose,input_hash,input_preview,status,error_code,created_at)
      VALUES (?,?,?,?,?,?,'failed',?,?)`, [runId, orderId, user.id, purpose, inputHash, input.slice(0, 300), errorCode, timestamp]);
    const status = errorCode === 'AI_NOT_CONFIGURED' ? 503 : errorCode.startsWith('AI_') ? 502 : 500;
    throw new HttpError(status, errorCode, error.message);
  }
}

async function approveAutomationJob(request, env, user, jobId) {
  assertMethod(request, 'POST');
  const job = await dbFirst(env, 'SELECT * FROM automation_jobs WHERE id=?', [jobId]);
  if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', 'Операция не найдена.');
  if (job.action_type !== 'telegram_payment_review') throw new HttpError(409, 'JOB_NOT_APPROVABLE', 'Эту операцию нельзя отправить вручную.');
  if (job.status === 'done') return json(request, env, { ok: true, duplicate: true, jobId });
  if (job.status !== 'review') throw new HttpError(409, 'JOB_NOT_APPROVABLE', 'Операция уже выполняется или требует повтора после ошибки.');
  if (!telegramConfigured(env)) throw new HttpError(503, 'TELEGRAM_NOT_CONFIGURED', 'Telegram ещё не настроен. Добавьте секреты бота, чат и привязку сотрудника.');
  const payload = { ...JSON.parse(job.payload_json || '{}'), manuallyApprovedBy: user.id, manuallyApprovedAt: nowIso() };
  await dbRun(env, `UPDATE automation_jobs SET status='pending',payload_json=?,run_after=?,updated_at=? WHERE id=? AND status='review'`,
    [JSON.stringify(payload), nowIso(), nowIso(), jobId]);
  const result = await runAutomationJob(env, jobId);
  if (result.failed) throw new HttpError(502, 'TELEGRAM_SEND_FAILED', 'Telegram не получил сообщение. Ошибка сохранена в очереди; операцию можно безопасно повторить.');
  return json(request, env, { ok: true, duplicate: Boolean(result.duplicate), jobId, result });
}

async function telegramStaffFromCallback(env, telegramUserId) {
  const binding = parseTelegramBindings(env.TELEGRAM_ADMIN_BINDINGS)
    .find((item) => item.telegramUserId === String(telegramUserId));
  if (!binding) return null;
  const staff = await dbFirst(env, 'SELECT id,email,name,role,is_active FROM staff_users WHERE email=?', [binding.staffEmail]);
  if (!staff || Number(staff.is_active) !== 1 || !['owner', 'manager'].includes(staff.role)) return null;
  return staff;
}

async function handleTelegramWebhook(request, env) {
  assertMethod(request, 'POST');
  if (!env.TELEGRAM_WEBHOOK_SECRET || !constantTimeEqual(request.headers.get('x-telegram-bot-api-secret-token'), env.TELEGRAM_WEBHOOK_SECRET)) {
    throw new HttpError(403, 'INVALID_TELEGRAM_SECRET', 'Webhook Telegram не подтверждён.');
  }
  const update = await readJson(request, 200_000);
  const providerEventId = cleanText(update.update_id, 80, { required: true, field: 'Telegram update_id' });
  const duplicate = await dbFirst(env, `SELECT id,status FROM webhook_events WHERE provider='telegram' AND provider_event_id=?`, [providerEventId]);
  if (duplicate) return json(request, env, { ok: true, duplicate: true });
  const timestamp = nowIso();
  const webhookId = makeId('whk');
  const inserted = await dbRun(env, `INSERT OR IGNORE INTO webhook_events
    (id,provider,provider_event_id,payload_hash,signature_valid,status,created_at)
    VALUES (?,'telegram',?,?,1,'processing',?)`, [webhookId, providerEventId, await sha256(JSON.stringify(update)), timestamp]);
  if (Number(inserted.meta?.changes || 0) !== 1) return json(request, env, { ok: true, duplicate: true });
  const callback = update.callback_query;
  const match = String(callback?.data || '').match(/^pay_(confirm|reject):(pay_[A-Za-z0-9-]+)$/);
  if (!match) {
    await dbRun(env, `UPDATE webhook_events SET status='ignored' WHERE id=?`, [webhookId]);
    return json(request, env, { ok: true, ignored: true });
  }
  const expectedChatId = String(env.TELEGRAM_ADMIN_CHAT_ID || '');
  const callbackChatId = String(callback?.message?.chat?.id ?? '');
  const staff = await telegramStaffFromCallback(env, callback?.from?.id);
  if (!staff || !expectedChatId || callbackChatId !== expectedChatId) {
    await dbRun(env, `UPDATE webhook_events SET status='rejected' WHERE id=?`, [webhookId]);
    await answerTelegramCallback(env, callback.id, 'Нет доступа к подтверждению.', true).catch(() => {});
    return json(request, env, { ok: true, rejected: true });
  }
  const paymentId = match[2];
  const telegramRequest = await dbFirst(env, `SELECT t.*,p.status AS payment_status,p.expected_amount_minor,p.currency,p.method,p.provider,p.external_reference,
    o.public_code FROM telegram_payment_requests t JOIN payment_records p ON p.id=t.payment_id
    JOIN orders o ON o.id=p.order_id WHERE t.payment_id=?`, [paymentId]);
  const callbackMessageId = String(callback?.message?.message_id ?? '');
  if (!telegramRequest || telegramRequest.status !== 'sent' || telegramRequest.telegram_chat_id !== callbackChatId
      || telegramRequest.telegram_message_id !== callbackMessageId) {
    await dbRun(env, `UPDATE webhook_events SET status='rejected' WHERE id=?`, [webhookId]);
    await answerTelegramCallback(env, callback.id, 'Запрос устарел или уже обработан.', true).catch(() => {});
    return json(request, env, { ok: true, rejected: true });
  }
  const claimed = await dbRun(env, `UPDATE telegram_payment_requests SET status='prepared',updated_at=? WHERE id=? AND status='sent'`,
    [nowIso(), telegramRequest.id]);
  if (Number(claimed.meta?.changes || 0) !== 1) {
    await dbRun(env, `UPDATE webhook_events SET status='duplicate' WHERE id=?`, [webhookId]);
    await answerTelegramCallback(env, callback.id, 'Запрос уже обрабатывается.', true).catch(() => {});
    return json(request, env, { ok: true, duplicate: true });
  }
  const action = match[1] === 'confirm' ? 'confirm' : 'reject';
  const internalRequest = new Request(request.url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  try {
    await reviewPaymentRecord(internalRequest, env, staff, paymentId);
  } catch (error) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE telegram_payment_requests SET status='failed',last_error_code=?,last_error_message=?,updated_at=? WHERE id=?`)
        .bind(cleanText(error.code || 'PAYMENT_REVIEW_FAILED', 80), cleanText(error.message, 500), nowIso(), telegramRequest.id),
      env.DB.prepare(`UPDATE webhook_events SET status='failed' WHERE id=?`).bind(webhookId),
    ]);
    throw error;
  }
  const finalStatus = action === 'confirm' ? 'confirmed' : 'rejected';
  await env.DB.batch([
    env.DB.prepare(`UPDATE telegram_payment_requests SET status=?,resolved_at=?,updated_at=? WHERE id=?`)
      .bind(finalStatus, nowIso(), nowIso(), telegramRequest.id),
    env.DB.prepare(`UPDATE webhook_events SET status='done' WHERE id=?`).bind(webhookId),
  ]);
  const original = buildTelegramPaymentMessage({
    order: { public_code: telegramRequest.public_code },
    payment: telegramRequest,
  });
  const resultText = `${original}\n\n${action === 'confirm' ? `✅ Подтверждено: ${staff.name}` : `❌ Отклонено: ${staff.name}`}`;
  await answerTelegramCallback(env, callback.id, action === 'confirm' ? 'Оплата подтверждена.' : 'Оплата отклонена.').catch(() => {});
  await markTelegramPaymentReviewed(env, callback, resultText).catch(() => {});
  return json(request, env, { ok: true, paymentId, status: finalStatus });
}

async function listJobs(request, env) {
  const jobs = await dbAll(env, `SELECT j.*,o.public_code FROM automation_jobs j LEFT JOIN orders o ON o.id=j.order_id
    WHERE j.status IN ('review','failed','dead','pending') ORDER BY j.updated_at DESC LIMIT 200`);
  return json(request, env, { ok: true, jobs });
}

async function listRules(request, env) {
  const rules = await dbAll(env, 'SELECT * FROM automation_rules ORDER BY name');
  return json(request, env, { ok: true, rules });
}

async function updateRule(request, env, ruleId) {
  assertMethod(request, 'PATCH');
  const body = await readJson(request, 10_000);
  const rule = await dbFirst(env, 'SELECT * FROM automation_rules WHERE id=?', [ruleId]);
  if (!rule) throw new HttpError(404, 'RULE_NOT_FOUND', 'Правило не найдено.');
  const enabled = body.enabled === undefined ? Number(rule.enabled) : (body.enabled ? 1 : 0);
  const mode = body.mode === undefined ? rule.mode : cleanText(body.mode, 20);
  if (!['review', 'live'].includes(mode)) throw new HttpError(422, 'VALIDATION_ERROR', 'Неизвестный режим правила.');
  if (mode === 'live' && rule.action_type !== 'prepare_manager_review') {
    const telegramApproved = rule.action_type === 'telegram_payment_review'
      && env.TELEGRAM_LIVE_APPROVED === 'true' && telegramConfigured(env);
    if (!telegramApproved) {
      throw new HttpError(409, 'LIVE_MODE_NOT_APPROVED', 'Сначала настройте Telegram, проверьте ручную отправку и отдельно включите TELEGRAM_LIVE_APPROVED.');
    }
  }
  await dbRun(env, 'UPDATE automation_rules SET enabled=?,mode=?,updated_at=? WHERE id=?', [enabled, mode, nowIso(), ruleId]);
  return json(request, env, { ok: true, rule: { ...rule, enabled, mode } });
}

async function retryJob(request, env, jobId) {
  assertMethod(request, 'POST');
  const job = await dbFirst(env, 'SELECT * FROM automation_jobs WHERE id=?', [jobId]);
  if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', 'Операция не найдена.');
  if (!['failed', 'dead'].includes(job.status)) throw new HttpError(409, 'JOB_NOT_RETRYABLE', 'Эту операцию нельзя повторить в текущем состоянии.');
  const timestamp = nowIso();
  await dbRun(env, `UPDATE automation_jobs SET status='pending',run_after=?,last_error_code=NULL,last_error_message=NULL,updated_at=? WHERE id=?`,
    [timestamp, timestamp, jobId]);
  if (job.action_type === 'telegram_payment_review') {
    await dbRun(env, `UPDATE telegram_payment_requests SET status='prepared',last_error_code=NULL,last_error_message=NULL,updated_at=? WHERE job_id=?`,
      [timestamp, jobId]);
  }
  return json(request, env, { ok: true, jobId, status: 'pending' });
}

export async function runAutomationJob(env, jobId) {
  const job = await dbFirst(env, 'SELECT * FROM automation_jobs WHERE id=?', [jobId]);
  if (!job || job.status !== 'pending') return { skipped: true };
  const timestamp = nowIso();
  const claim = await dbRun(env, `UPDATE automation_jobs SET status='running',attempts=attempts+1,updated_at=? WHERE id=? AND status='pending'`, [timestamp, jobId]);
  if (Number(claim.meta?.changes || 0) !== 1) return { skipped: true };
  try {
    if (job.action_type === 'prepare_manager_review') {
      await dbRun(env, `UPDATE automation_jobs SET status='review',updated_at=? WHERE id=?`, [nowIso(), jobId]);
      return { review: true };
    }
    if (job.action_type === 'telegram_payment_review') {
      const payload = JSON.parse(job.payload_json || '{}');
      const telegramRequest = await dbFirst(env, 'SELECT * FROM telegram_payment_requests WHERE job_id=?', [jobId]);
      if (!telegramRequest) throw Object.assign(new Error('Не найдена подготовленная Telegram-задача.'), { code: 'TELEGRAM_REQUEST_NOT_FOUND' });
      if (['sent', 'confirmed', 'rejected'].includes(telegramRequest.status)) {
        await dbRun(env, `UPDATE automation_jobs SET status='done',updated_at=? WHERE id=?`, [nowIso(), jobId]);
        return { done: true, duplicate: true };
      }
      const payment = await dbFirst(env, 'SELECT * FROM payment_records WHERE id=?', [payload.paymentId]);
      if (!payment || payment.status !== 'pending_verification') {
        throw Object.assign(new Error('Платёж уже обработан или не найден.'), { code: 'PAYMENT_NOT_PENDING' });
      }
      const order = await dbFirst(env, 'SELECT id,public_code FROM orders WHERE id=?', [payment.order_id]);
      const sent = await sendTelegramPaymentReview(env, { payment, order });
      await env.DB.batch([
        env.DB.prepare(`UPDATE telegram_payment_requests SET status='sent',telegram_chat_id=?,telegram_message_id=?,
          sent_at=?,last_error_code=NULL,last_error_message=NULL,updated_at=? WHERE id=?`)
          .bind(sent.chatId, sent.messageId, nowIso(), nowIso(), telegramRequest.id),
        env.DB.prepare(`UPDATE automation_jobs SET status='done',last_error_code=NULL,last_error_message=NULL,updated_at=? WHERE id=?`)
          .bind(nowIso(), jobId),
      ]);
      return { done: true, telegram: { messageId: sent.messageId } };
    }
    throw new Error('Автоматическое действие не подключено; требуется ручная обработка.');
  } catch (error) {
    const refreshed = await dbFirst(env, 'SELECT attempts,max_attempts FROM automation_jobs WHERE id=?', [jobId]);
    const status = Number(refreshed.attempts) >= Number(refreshed.max_attempts) ? 'dead' : 'failed';
    const errorCode = cleanText(error.code || 'ACTION_FAILED', 80);
    const errorMessage = cleanText(error.message, 500);
    const statements = [env.DB.prepare(`UPDATE automation_jobs SET status=?,last_error_code=?,last_error_message=?,updated_at=? WHERE id=?`)
      .bind(status, errorCode, errorMessage, nowIso(), jobId)];
    if (job.action_type === 'telegram_payment_review') {
      statements.push(env.DB.prepare(`UPDATE telegram_payment_requests SET status='failed',last_error_code=?,last_error_message=?,updated_at=? WHERE job_id=?`)
        .bind(errorCode, errorMessage, nowIso(), jobId));
    }
    await env.DB.batch(statements);
    return { failed: true, status };
  }
}

async function publicProducts(request, env) {
  const rows = await dbAll(env, `SELECT p.*,
    (SELECT GROUP_CONCAT(storage_key,'|') FROM product_images pi WHERE pi.product_id=p.id ORDER BY pi.position) AS image_keys
    FROM products p WHERE p.status='active' ORDER BY p.updated_at DESC LIMIT 500`);
  const products = rows.map((row) => ({
    id: row.id,
    title: row.name,
    description: row.description || '',
    category: row.category || 'accessories',
    platform: row.platform || detectPlatform(row.source_url || ''),
    sourceUrl: row.source_url || '',
    priceCny: row.source_currency === 'CNY' && row.source_price_minor !== null ? row.source_price_minor / 100 : 0,
    priceRub: row.sale_currency === 'RUB' && row.sale_price_minor !== null ? row.sale_price_minor / 100 : 0,
    images: row.image_keys ? row.image_keys.split('|').map((key) => `/media/${key}`) : [],
    createdAt: row.created_at,
  }));
  return json(request, env, { ok: true, products }, 200, { 'cache-control': 'public, max-age=30' });
}

function mediaExtension(contentType) {
  const map = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif' };
  return map[String(contentType || '').split(';')[0].toLowerCase()] || '';
}

async function importProduct(request, env) {
  assertMethod(request, 'POST');
  if (!legacyAdminAuthorized(request, env)) {
    const user = await getCurrentUser(request, env);
    if (!user || !['owner', 'manager'].includes(user.role)) throw new HttpError(401, 'AUTH_REQUIRED', 'Требуется токен импорта или вход менеджера.');
  }
  if (!env.STORAGE) throw new HttpError(503, 'STORAGE_NOT_CONFIGURED', 'Хранилище фотографий не подключено.');
  const body = await readJson(request, 300_000);
  const title = cleanText(body.title, 500, { required: true, field: 'Название' });
  const sourceUrl = cleanText(body.sourceUrl, 1500, { required: true, field: 'Ссылка на источник' });
  if (!isSafeRemoteUrl(sourceUrl)) throw new HttpError(422, 'UNSAFE_SOURCE_URL', 'Некорректная ссылка на источник.');
  const images = (Array.isArray(body.images) ? body.images : []).slice(0, 12).filter(isSafeRemoteUrl);
  if (!images.length) throw new HttpError(422, 'NO_IMAGES', 'Не найдено безопасных ссылок на фотографии.');
  const productId = makeId('prd');
  const stored = [];
  const failures = [];
  for (let index = 0; index < images.length; index += 1) {
    try {
      const imageResponse = await fetch(images[index], { redirect: 'follow' });
      const contentType = imageResponse.headers.get('content-type') || '';
      const extension = mediaExtension(contentType);
      const length = Number(imageResponse.headers.get('content-length') || 0);
      if (!imageResponse.ok || !extension || length > 12_000_000) throw new Error('Файл не прошёл проверку изображения.');
      const bytes = await imageResponse.arrayBuffer();
      if (bytes.byteLength > 12_000_000) throw new Error('Файл больше 12 МБ.');
      const key = `products/${productId}/${String(index + 1).padStart(2, '0')}.${extension}`;
      await env.STORAGE.put(key, bytes, { httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' } });
      stored.push(key);
    } catch (error) {
      failures.push({ index, code: 'IMAGE_COPY_FAILED' });
    }
  }
  if (!stored.length) throw new HttpError(422, 'IMAGE_COPY_FAILED', 'Не удалось сохранить ни одной фотографии.', { failures });
  const timestamp = nowIso();
  const sku = cleanText(body.sku, 120) || `ONYX-${productId.slice(-8).toUpperCase()}`;
  const variantId = makeId('var');
  const statements = [
    env.DB.prepare(`INSERT INTO products
      (id,sku,name,category,description,platform,source_url,source_price_minor,source_currency,sale_price_minor,sale_currency,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?,?)`).bind(productId, sku, title, cleanText(body.category, 120) || null,
      cleanText(body.description, 4000) || null, cleanText(body.platform, 80) || detectPlatform(sourceUrl), sourceUrl,
      Number.isFinite(Number(body.priceCny)) ? Math.round(Number(body.priceCny) * 100) : null, 'CNY',
      Number.isFinite(Number(body.priceRub)) ? Math.round(Number(body.priceRub) * 100) : null, 'RUB', timestamp, timestamp),
    env.DB.prepare('INSERT INTO product_variants (id,product_id,sku,name,attributes_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .bind(variantId, productId, sku, 'Основной вариант', '{}', timestamp, timestamp),
    ...stored.map((key, index) => env.DB.prepare('INSERT INTO product_images (id,product_id,storage_key,position,created_at) VALUES (?,?,?,?,?)')
      .bind(makeId('img'), productId, key, index, timestamp)),
  ];
  await env.DB.batch(statements);
  return json(request, env, { ok: true, product: { id: productId, title, images: stored.map((key) => `/media/${key}`) }, failures }, 201);
}

async function serveMedia(request, env, key) {
  if (!env.STORAGE) throw new HttpError(404, 'NOT_FOUND', 'Файл не найден.');
  const object = await env.STORAGE.get(key);
  if (!object) throw new HttpError(404, 'NOT_FOUND', 'Файл не найден.');
  const headers = new Headers({ 'cache-control': 'public, max-age=31536000, immutable', etag: object.httpEtag || '' });
  if (object.writeHttpMetadata) object.writeHttpMetadata(headers);
  headers.set('x-content-type-options', 'nosniff');
  return new Response(object.body, { headers });
}

async function tracking(request, env, code) {
  if (request.method === 'GET') {
    const order = await dbFirst(env, 'SELECT * FROM orders WHERE public_code=?', [code.toUpperCase()]);
    if (!order) throw new HttpError(404, 'TRACKING_NOT_FOUND', 'Трек-код не найден.');
    return json(request, env, { ok: true, tracking: trackingFromOrder(order) }, 200, { 'cache-control': 'public, max-age=20' });
  }
  if (request.method === 'PUT') {
    let user = null;
    if (!legacyAdminAuthorized(request, env)) user = await requireUser(request, env, ['owner', 'manager']);
    const order = await dbFirst(env, 'SELECT * FROM orders WHERE public_code=?', [code.toUpperCase()]);
    if (!order) throw new HttpError(404, 'TRACKING_NOT_FOUND', 'Трек-код не найден.');
    const body = await readJson(request, 20_000);
    const deliveryStatus = cleanText(body.deliveryStatus, 40);
    if (deliveryStatus) {
      if (!DELIVERY_STATUSES.includes(deliveryStatus)) throw new HttpError(422, 'INVALID_STATUS', 'Неизвестный статус доставки.');
      try { assertTransition('delivery', order.delivery_status, deliveryStatus); }
      catch (error) { throw new HttpError(409, 'INVALID_STATUS_TRANSITION', error.message); }
    }
    const timestamp = nowIso();
    await dbRun(env, `UPDATE orders SET delivery_status=?,tracking_location=?,tracking_next=?,tracking_eta=?,updated_at=?,version=version+1 WHERE id=?`,
      [deliveryStatus || order.delivery_status, cleanText(body.location, 300) || order.tracking_location,
        cleanText(body.next, 300) || order.tracking_next, cleanText(body.eta, 120) || order.tracking_eta, timestamp, order.id]);
    await dbRun(env, 'INSERT INTO order_events (id,order_id,actor_user_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?,?)',
      [makeId('evt'), order.id, user?.id || null, 'tracking_updated', JSON.stringify({ deliveryStatus: deliveryStatus || order.delivery_status }), timestamp]);
    const updated = await dbFirst(env, 'SELECT * FROM orders WHERE id=?', [order.id]);
    return json(request, env, { ok: true, tracking: trackingFromOrder(updated) });
  }
  throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Метод не поддерживается.');
}

async function handleAdminApi(request, env, url) {
  const path = url.pathname;
  const user = await requireUser(request, env);
  if (path === '/api/admin/dashboard' && request.method === 'GET') return dashboard(request, env);
  if (path === '/api/admin/orders' && request.method === 'GET') return listOrders(request, env, user, url);
  if (path === '/api/admin/staff' && request.method === 'GET') { await requireUser(request, env, ['owner', 'manager']); return listStaff(request, env); }
  if (path === '/api/admin/staff' && request.method === 'POST') { await requireUser(request, env, ['owner']); return createStaff(request, env); }
  if (path === '/api/admin/suppliers' && request.method === 'GET') return listSuppliers(request, env);
  if (path === '/api/admin/suppliers' && request.method === 'POST') { await requireUser(request, env, ['owner', 'manager']); return createSupplier(request, env); }
  if (path === '/api/admin/products' && request.method === 'GET') return listProductsAdmin(request, env);
  if (path === '/api/admin/products' && request.method === 'POST') { await requireUser(request, env, ['owner', 'manager']); return createProduct(request, env); }
  if (path === '/api/admin/offers' && request.method === 'GET') return listOffers(request, env);
  if (path === '/api/admin/offers/import') { await requireUser(request, env, ['owner', 'manager']); return importOffers(request, env); }
  if (path === '/api/admin/jobs' && request.method === 'GET') return listJobs(request, env);
  if (path === '/api/admin/rules' && request.method === 'GET') return listRules(request, env);
  if (path === '/api/admin/integrations/status' && request.method === 'GET') return integrationStatus(request, env);

  let match = path.match(/^\/api\/admin\/orders\/([^/]+)$/);
  if (match && request.method === 'GET') return orderDetail(request, env, user, decodeURIComponent(match[1]));
  if (match && request.method === 'PATCH') { await requireUser(request, env, ['owner', 'manager']); return updateOrder(request, env, user, decodeURIComponent(match[1])); }
  match = path.match(/^\/api\/admin\/orders\/([^/]+)\/supplier-orders$/);
  if (match) { await requireUser(request, env, ['owner', 'manager']); return createSupplierOrder(request, env, user, decodeURIComponent(match[1])); }
  match = path.match(/^\/api\/admin\/orders\/([^/]+)\/money-movements$/);
  if (match) { await requireUser(request, env, ['owner', 'finance']); return createMoneyMovement(request, env, user, decodeURIComponent(match[1])); }
  match = path.match(/^\/api\/admin\/orders\/([^/]+)\/payments$/);
  if (match) { await requireUser(request, env, ['owner', 'finance']); return createPaymentRecord(request, env, user, decodeURIComponent(match[1])); }
  match = path.match(/^\/api\/admin\/orders\/([^/]+)\/assistant$/);
  if (match) { await requireUser(request, env, ['owner', 'manager']); return assistantForOrder(request, env, user, decodeURIComponent(match[1])); }
  match = path.match(/^\/api\/admin\/payments\/([^/]+)$/);
  if (match) { await requireUser(request, env, ['owner']); return reviewPaymentRecord(request, env, user, decodeURIComponent(match[1])); }
  match = path.match(/^\/api\/admin\/orders\/([^/]+)\/shipments$/);
  if (match) { await requireUser(request, env, ['owner', 'manager']); return createShipment(request, env, user, decodeURIComponent(match[1])); }
  match = path.match(/^\/api\/admin\/shipments\/([^/]+)$/);
  if (match) { await requireUser(request, env, ['owner']); return updateShipment(request, env, user, decodeURIComponent(match[1])); }
  match = path.match(/^\/api\/admin\/orders\/([^/]+)\/finance$/);
  if (match) { await requireUser(request, env, ['owner', 'finance']); return updateOrderFinance(request, env, user, decodeURIComponent(match[1])); }
  match = path.match(/^\/api\/admin\/supplier-orders\/([^/]+)$/);
  if (match) { await requireUser(request, env, ['owner', 'manager']); return updateSupplierOrder(request, env, user, decodeURIComponent(match[1])); }
  match = path.match(/^\/api\/admin\/jobs\/([^/]+)\/retry$/);
  if (match) { await requireUser(request, env, ['owner', 'manager']); return retryJob(request, env, decodeURIComponent(match[1])); }
  match = path.match(/^\/api\/admin\/jobs\/([^/]+)\/approve$/);
  if (match) { await requireUser(request, env, ['owner', 'manager']); return approveAutomationJob(request, env, user, decodeURIComponent(match[1])); }
  match = path.match(/^\/api\/admin\/rules\/([^/]+)$/);
  if (match) { await requireUser(request, env, ['owner']); return updateRule(request, env, decodeURIComponent(match[1])); }
  throw new HttpError(404, 'NOT_FOUND', 'Маршрут не найден.');
}

export async function handleRequest(request, env, context = {}) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    assertAllowedOrigin(request, env);
    const headers = responseHeaders(request, env);
    headers.set('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    headers.set('access-control-allow-headers', 'Content-Type,Idempotency-Key,Authorization,X-Setup-Token');
    headers.set('access-control-max-age', '86400');
    return new Response(null, { status: 204, headers });
  }
  if (url.pathname === '/health') return json(request, env, { ok: true, service: 'onyx-ops', time: nowIso() });
  if (url.pathname === '/admin' || url.pathname === '/admin/') return html(request, env, adminShell());
  if (url.pathname === '/api/admin/bootstrap') return handleBootstrap(request, env);
  if (url.pathname === '/api/auth/login') return handleLogin(request, env);
  if (url.pathname === '/api/auth/logout') return handleLogout(request, env);
  if (url.pathname === '/api/auth/me') {
    const user = await requireUser(request, env);
    return json(request, env, { ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  }
  if (url.pathname === '/api/webhooks/telegram') return handleTelegramWebhook(request, env);
  if (url.pathname === '/api/orders') return createPublicOrder(request, env, context);
  if (url.pathname === '/api/products' && request.method === 'GET') return publicProducts(request, env);
  if (url.pathname === '/api/import') return importProduct(request, env);
  if (url.pathname.startsWith('/api/admin/')) return handleAdminApi(request, env, url);
  const trackingMatch = url.pathname.match(/^\/api\/tracking\/([^/]+)$/);
  if (trackingMatch) return tracking(request, env, decodeURIComponent(trackingMatch[1]));
  const mediaMatch = url.pathname.match(/^\/media\/(.+)$/);
  if (mediaMatch && request.method === 'GET') return serveMedia(request, env, decodeURIComponent(mediaMatch[1]));
  throw new HttpError(404, 'NOT_FOUND', 'Маршрут не найден.');
}

async function fetchHandler(request, env, context) {
  try {
    return await handleRequest(request, env, context);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const code = error instanceof HttpError ? error.code : 'INTERNAL_ERROR';
    if (status >= 500) console.error(JSON.stringify({ code, path: new URL(request.url).pathname, message: String(error.message || error).slice(0, 300) }));
    return json(request, env, {
      ok: false,
      error: { code, message: status >= 500 ? 'Внутренняя ошибка сервиса.' : error.message, details: error instanceof HttpError ? error.details : null },
    }, status);
  }
}

export { mediaExtension };

export default {
  fetch: fetchHandler,
  async scheduled(_event, env, context) {
    const jobs = await dbAll(env, `SELECT id FROM automation_jobs WHERE status='pending' AND run_after<=? ORDER BY run_after LIMIT 20`, [nowIso()]);
    for (const job of jobs) context.waitUntil(runAutomationJob(env, job.id));
  },
};
