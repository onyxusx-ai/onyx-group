const encoder = new TextEncoder();

export function constantTimeEqual(left, right) {
  const a = encoder.encode(String(left || ''));
  const b = encoder.encode(String(right || ''));
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index] || 0) ^ (b[index] || 0);
  return difference === 0;
}

export function redactSensitiveText(value, max = 4000) {
  return String(value || '')
    .replace(/\b(?:\d[ -]?){12,19}\b/g, '[платёжные данные скрыты]')
    .replace(/\b(?:cvv|cvc)\s*[:=]?\s*\d{3,4}\b/gi, '[код карты скрыт]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[ключ скрыт]')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}

export function parseTelegramBindings(value) {
  return String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const separator = entry.indexOf(':');
    if (separator < 1) return null;
    const telegramUserId = entry.slice(0, separator).trim();
    const staffEmail = entry.slice(separator + 1).trim().toLowerCase();
    if (!/^-?\d+$/.test(telegramUserId) || !staffEmail.includes('@')) return null;
    return { telegramUserId, staffEmail };
  }).filter(Boolean);
}

function formatMoney(amountMinor, currency) {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: currency || 'RUB' }).format(Number(amountMinor || 0) / 100);
}

export function buildTelegramPaymentMessage({ payment, order }) {
  const provider = redactSensitiveText(payment.provider || 'не указан', 120);
  const reference = redactSensitiveText(payment.external_reference || 'не указан', 160);
  return [
    'ONYX GROUP · проверка оплаты',
    '',
    `Заказ: ${order.public_code}`,
    `Сумма: ${formatMoney(payment.expected_amount_minor, payment.currency)}`,
    `Способ: ${payment.method === 'bank_transfer' ? 'перевод' : 'платёжный сервис'}`,
    `Банк/сервис: ${provider}`,
    `Номер операции: ${reference}`,
    '',
    'Сверьте поступление в банке. Бот сам деньги не проверяет.',
  ].join('\n');
}

async function outboundFetch(env, url, options) {
  const fetcher = typeof env.OUTBOUND_FETCH === 'function' ? env.OUTBOUND_FETCH : fetch;
  return fetcher(url, options);
}

async function telegramCall(env, method, payload) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '');
  if (!token) throw Object.assign(new Error('Не задан TELEGRAM_BOT_TOKEN.'), { code: 'TELEGRAM_NOT_CONFIGURED' });
  const response = await outboundFetch(env, `https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) {
    const description = redactSensitiveText(data.description || `HTTP ${response.status}`, 300);
    throw Object.assign(new Error(`Telegram не принял запрос: ${description}`), { code: 'TELEGRAM_API_ERROR' });
  }
  return data.result;
}

export async function sendTelegramPaymentReview(env, { payment, order }) {
  const chatId = String(env.TELEGRAM_ADMIN_CHAT_ID || '');
  if (!chatId) throw Object.assign(new Error('Не задан TELEGRAM_ADMIN_CHAT_ID.'), { code: 'TELEGRAM_NOT_CONFIGURED' });
  const result = await telegramCall(env, 'sendMessage', {
    chat_id: chatId,
    text: buildTelegramPaymentMessage({ payment, order }),
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Подтвердить', callback_data: `pay_confirm:${payment.id}` },
        { text: '❌ Отклонить', callback_data: `pay_reject:${payment.id}` },
      ]],
    },
  });
  return { chatId: String(result.chat?.id ?? chatId), messageId: String(result.message_id) };
}

export async function answerTelegramCallback(env, callbackQueryId, text, showAlert = false) {
  if (!callbackQueryId) return null;
  return telegramCall(env, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: redactSensitiveText(text, 180),
    show_alert: Boolean(showAlert),
  });
}

export async function markTelegramPaymentReviewed(env, callbackQuery, text) {
  const chatId = callbackQuery?.message?.chat?.id;
  const messageId = callbackQuery?.message?.message_id;
  if (chatId === undefined || messageId === undefined) return null;
  return telegramCall(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: redactSensitiveText(text, 3900),
  });
}

export function extractOpenAIText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') return content.text.trim();
    }
  }
  return '';
}

export async function runOnyxAssistant(env, { purpose, input, orderContext }) {
  const apiKey = String(env.OPENAI_API_KEY || '');
  const model = String(env.OPENAI_MODEL || '');
  if (!apiKey || !model) throw Object.assign(new Error('ИИ не настроен: нужны OPENAI_API_KEY и OPENAI_MODEL.'), { code: 'AI_NOT_CONFIGURED' });
  const safeInput = redactSensitiveText(input, 4000);
  if (!safeInput) throw Object.assign(new Error('Напишите сообщение или вопрос для помощника.'), { code: 'AI_EMPTY_INPUT' });
  const purposeLabels = {
    next_action: 'Объясни менеджеру следующее безопасное действие по заказу простыми словами.',
    supplier_message: 'Подготовь короткое сообщение поставщику для WeChat на русском и английском. Не выдумывай цену или наличие.',
    supplier_reply: 'Разбери ответ поставщика. Отдельно перечисли подтверждённые цену, остаток и срок; неизвестное пометь как неизвестное.',
    customer_reply: 'Подготовь понятный ответ клиенту. Не обещай оплату, наличие или срок, если они не подтверждены.',
  };
  const task = purposeLabels[purpose];
  if (!task) throw Object.assign(new Error('Неизвестная задача ИИ-помощника.'), { code: 'AI_INVALID_PURPOSE' });
  const response = await outboundFetch(env, 'https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      store: false,
      max_output_tokens: 700,
      instructions: [
        'Ты ИИ-помощник менеджера ONYX GROUP.',
        'Ты можешь только анализировать текст и готовить черновики.',
        'Никогда не подтверждай оплату, возврат, отправку или изменение финансовых данных.',
        'Не проси и не повторяй номер карты, CVV, пароль, seed-фразу или API-ключ.',
        'Отвечай по-русски, коротко и конкретно. Факты не додумывай.',
      ].join(' '),
      input: `${task}\n\nКонтекст заказа без персональных данных:\n${JSON.stringify(orderContext)}\n\nТекст менеджера:\n${safeInput}`,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = redactSensitiveText(data?.error?.message || `HTTP ${response.status}`, 300);
    throw Object.assign(new Error(`OpenAI API не выполнил запрос: ${message}`), { code: 'AI_PROVIDER_ERROR' });
  }
  const output = redactSensitiveText(extractOpenAIText(data), 6000);
  if (!output) throw Object.assign(new Error('ИИ вернул пустой ответ.'), { code: 'AI_EMPTY_RESPONSE' });
  return { output, model: String(data.model || model), safeInput };
}
