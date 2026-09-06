import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTelegramPaymentMessage,
  constantTimeEqual,
  extractOpenAIText,
  parseTelegramBindings,
  redactSensitiveText,
  runOnyxAssistant,
  sendTelegramPaymentReview,
} from '../src/assistant-integrations.mjs';

test('Telegram binding разрешает только явную пару ID и сотрудника', () => {
  assert.deepEqual(parseTelegramBindings('123:owner@onyx.test, bad, 456:manager@onyx.test'), [
    { telegramUserId: '123', staffEmail: 'owner@onyx.test' },
    { telegramUserId: '456', staffEmail: 'manager@onyx.test' },
  ]);
  assert.equal(constantTimeEqual('secret', 'secret'), true);
  assert.equal(constantTimeEqual('secret', 'other'), false);
});

test('платёжные данные маскируются до ИИ и Telegram', () => {
  const masked = redactSensitiveText('карта 4111 1111 1111 1111 CVV 123 sk-abcdefghijklmnop');
  assert.doesNotMatch(masked, /4111/);
  assert.doesNotMatch(masked, /123/);
  assert.doesNotMatch(masked, /sk-/);
  const text = buildTelegramPaymentMessage({
    order: { public_code: 'ONYX-1' },
    payment: { id: 'pay_1', expected_amount_minor: 12345, currency: 'RUB', method: 'bank_transfer', provider: 'Банк', external_reference: 'REF-1' },
  });
  assert.match(text, /123,45/);
  assert.match(text, /сам деньги не проверяет/);
});

test('Telegram получает кнопки подтверждения и отклонения', async () => {
  let request;
  const env = {
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_ADMIN_CHAT_ID: '777',
    async OUTBOUND_FETCH(url, options) {
      request = { url, body: JSON.parse(options.body) };
      return Response.json({ ok: true, result: { message_id: 42, chat: { id: 777 } } });
    },
  };
  const result = await sendTelegramPaymentReview(env, {
    order: { public_code: 'ONYX-1' },
    payment: { id: 'pay_1', expected_amount_minor: 10000, currency: 'RUB', method: 'bank_transfer' },
  });
  assert.equal(result.messageId, '42');
  assert.match(request.url, /sendMessage$/);
  assert.equal(request.body.reply_markup.inline_keyboard[0][0].callback_data, 'pay_confirm:pay_1');
});

test('ИИ-помощник использует Responses API и не хранит ответ на стороне API', async () => {
  let request;
  const env = {
    OPENAI_API_KEY: 'test-key',
    OPENAI_MODEL: 'test-model',
    async OUTBOUND_FETCH(url, options) {
      request = { url, body: JSON.parse(options.body) };
      return Response.json({ model: 'test-model', output: [{ content: [{ type: 'output_text', text: 'Проверьте остаток.' }] }] });
    },
  };
  const result = await runOnyxAssistant(env, { purpose: 'next_action', input: 'Что делать?', orderContext: { code: 'ONYX-1' } });
  assert.equal(result.output, 'Проверьте остаток.');
  assert.equal(request.body.store, false);
  assert.match(request.url, /\/v1\/responses$/);
  assert.equal(extractOpenAIText({ output_text: 'Готово' }), 'Готово');
});
