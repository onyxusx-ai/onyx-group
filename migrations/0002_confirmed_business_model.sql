-- Зафиксированные решения владельца: B2C + партнёры, ручная проверка оплаты,
-- связь с карго и рабочее время поставщиков по часовому поясу Китая.

ALTER TABLE customers ADD COLUMN customer_type TEXT NOT NULL DEFAULT 'consumer'
  CHECK (customer_type IN ('consumer', 'dropshipper', 'both'));

ALTER TABLE orders ADD COLUMN buyer_type TEXT NOT NULL DEFAULT 'consumer'
  CHECK (buyer_type IN ('consumer', 'dropshipper'));

ALTER TABLE suppliers ADD COLUMN contact_timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai';
ALTER TABLE suppliers ADD COLUMN contact_window_start TEXT;
ALTER TABLE suppliers ADD COLUMN contact_window_end TEXT;

CREATE TABLE payment_records (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  method TEXT NOT NULL CHECK (method IN ('bank_transfer', 'payment_provider', 'cash', 'other')),
  status TEXT NOT NULL DEFAULT 'pending_verification'
    CHECK (status IN ('pending_verification', 'confirmed', 'rejected', 'cancelled')),
  expected_amount_minor INTEGER NOT NULL CHECK (expected_amount_minor >= 0),
  received_amount_minor INTEGER CHECK (received_amount_minor >= 0),
  currency TEXT NOT NULL,
  provider TEXT,
  external_reference TEXT,
  note TEXT,
  created_by TEXT NOT NULL REFERENCES staff_users(id),
  confirmed_by TEXT REFERENCES staff_users(id),
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_payment_records_order_status
ON payment_records(order_id, status);

CREATE TABLE shipments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  cargo_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_confirmation'
    CHECK (status IN ('pending_confirmation', 'confirmed', 'partially_shipped', 'shipped', 'delivered', 'not_collected', 'returning', 'returned', 'issue', 'cancelled')),
  tracking_code TEXT,
  pieces INTEGER NOT NULL DEFAULT 1 CHECK (pieces > 0),
  note TEXT,
  confirmed_by TEXT REFERENCES staff_users(id),
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_shipments_order_status ON shipments(order_id, status);

PRAGMA optimize;
