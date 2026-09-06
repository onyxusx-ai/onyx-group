-- ИИ-помощник и подтверждение оплаты через закрытый Telegram-чат.
-- Секреты бота и OpenAI хранятся только в переменных окружения.

CREATE TABLE ai_runs (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  staff_user_id TEXT NOT NULL REFERENCES staff_users(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('next_action', 'supplier_message', 'supplier_reply', 'customer_reply')),
  input_hash TEXT NOT NULL,
  input_preview TEXT NOT NULL,
  output_text TEXT,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_ai_runs_order_created ON ai_runs(order_id, created_at);

CREATE TABLE telegram_payment_requests (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL UNIQUE REFERENCES payment_records(id) ON DELETE CASCADE,
  job_id TEXT UNIQUE REFERENCES automation_jobs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared', 'sent', 'confirmed', 'rejected', 'failed')),
  telegram_chat_id TEXT,
  telegram_message_id TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  sent_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_telegram_payment_requests_status
ON telegram_payment_requests(status, updated_at);

PRAGMA optimize;
