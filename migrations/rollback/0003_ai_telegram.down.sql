-- Сначала остановите правило Telegram и сохраните журнал аудита.
DROP TABLE IF EXISTS telegram_payment_requests;
DROP TABLE IF EXISTS ai_runs;
PRAGMA optimize;
