PRAGMA foreign_keys = ON;

CREATE TABLE staff_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'finance')),
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE staff_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX idx_staff_sessions_user_id ON staff_sessions(user_id);
CREATE INDEX idx_staff_sessions_expires_at ON staff_sessions(expires_at);

CREATE TABLE login_attempts (
  identity_hash TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  blocked_until TEXT
);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  name TEXT,
  contact TEXT NOT NULL,
  normalized_contact TEXT NOT NULL UNIQUE,
  phone TEXT,
  email TEXT,
  country TEXT,
  city TEXT,
  address TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE staff_assignments (
  staff_id TEXT PRIMARY KEY REFERENCES staff_users(id) ON DELETE CASCADE,
  active_order_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  public_code TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  source_event_id TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  assigned_to TEXT REFERENCES staff_users(id),
  order_status TEXT NOT NULL DEFAULT 'new',
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  delivery_status TEXT NOT NULL DEFAULT 'not_started',
  price_review_status TEXT NOT NULL DEFAULT 'required',
  stock_review_status TEXT NOT NULL DEFAULT 'required',
  comment TEXT,
  sale_currency TEXT NOT NULL,
  sales_total_minor INTEGER,
  discount_minor INTEGER NOT NULL DEFAULT 0,
  purchase_estimate_minor INTEGER,
  delivery_cost_estimate_minor INTEGER,
  commission_cost_estimate_minor INTEGER,
  costs_complete INTEGER NOT NULL DEFAULT 0 CHECK (costs_complete IN (0, 1)),
  next_action_at TEXT,
  tracking_location TEXT,
  tracking_next TEXT,
  tracking_eta TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_orders_customer_id ON orders(customer_id);
CREATE INDEX idx_orders_status_created ON orders(order_status, created_at);
CREATE INDEX idx_orders_assigned_status ON orders(assigned_to, order_status);
CREATE INDEX idx_orders_payment_status ON orders(payment_status);
CREATE INDEX idx_orders_delivery_status ON orders(delivery_status);
CREATE INDEX idx_orders_attention ON orders(next_action_at)
WHERE order_status NOT IN ('delivered', 'returned', 'cancelled');

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT,
  description TEXT,
  platform TEXT,
  source_url TEXT,
  source_price_minor INTEGER,
  source_currency TEXT,
  sale_price_minor INTEGER,
  sale_currency TEXT,
  min_margin_bps INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_products_category_status ON products(category, status);

CREATE TABLE product_variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku TEXT NOT NULL UNIQUE,
  name TEXT,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_product_variants_product_id ON product_variants(product_id);

CREATE TABLE product_images (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_product_images_product_position ON product_images(product_id, position);

CREATE TABLE suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  channel TEXT NOT NULL DEFAULT 'manual',
  contact TEXT,
  default_currency TEXT,
  terms TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE supplier_offers (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  variant_id TEXT NOT NULL REFERENCES product_variants(id),
  supplier_sku TEXT NOT NULL,
  purchase_price_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  stock_qty INTEGER,
  stock_status TEXT NOT NULL DEFAULT 'unknown' CHECK (stock_status IN ('in_stock', 'out_of_stock', 'unknown')),
  lead_time_days INTEGER,
  shipping_terms TEXT,
  last_updated_at TEXT NOT NULL,
  stale_after_hours INTEGER NOT NULL DEFAULT 24,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (supplier_id, supplier_sku)
);

CREATE INDEX idx_supplier_offers_variant_id ON supplier_offers(variant_id);
CREATE INDEX idx_supplier_offers_supplier_id ON supplier_offers(supplier_id);
CREATE INDEX idx_supplier_offers_stock_updated ON supplier_offers(stock_status, last_updated_at);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id),
  variant_id TEXT REFERENCES product_variants(id),
  title TEXT NOT NULL,
  sku TEXT,
  variant_text TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  sale_unit_minor INTEGER,
  sale_currency TEXT NOT NULL,
  purchase_snapshot_minor INTEGER,
  purchase_currency TEXT,
  supplier_offer_id TEXT REFERENCES supplier_offers(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_order_items_order_id ON order_items(order_id);
CREATE INDEX idx_order_items_product_id ON order_items(product_id);

CREATE TABLE supplier_orders (
  id TEXT PRIMARY KEY,
  buyer_order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  status TEXT NOT NULL DEFAULT 'draft',
  supplier_reference TEXT,
  purchase_total_minor INTEGER,
  purchase_currency TEXT,
  purchase_total_reporting_minor INTEGER,
  reporting_currency TEXT,
  shipping_total_minor INTEGER,
  shipping_currency TEXT,
  tracking_code TEXT,
  confirmed_at TEXT,
  shipped_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_supplier_orders_buyer_order_id ON supplier_orders(buyer_order_id);
CREATE INDEX idx_supplier_orders_supplier_status ON supplier_orders(supplier_id, status);

CREATE TABLE supplier_order_items (
  id TEXT PRIMARY KEY,
  supplier_order_id TEXT NOT NULL REFERENCES supplier_orders(id) ON DELETE CASCADE,
  order_item_id TEXT NOT NULL REFERENCES order_items(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  purchase_unit_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_supplier_order_items_supplier_order ON supplier_order_items(supplier_order_id);
CREATE INDEX idx_supplier_order_items_order_item ON supplier_order_items(order_item_id);

CREATE TABLE money_movements (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  supplier_order_id TEXT REFERENCES supplier_orders(id),
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  category TEXT NOT NULL CHECK (category IN ('revenue', 'purchase', 'delivery', 'fee', 'discount', 'refund', 'tax', 'other')),
  status TEXT NOT NULL CHECK (status IN ('planned', 'actual')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL,
  occurred_at TEXT,
  note TEXT,
  external_event_id TEXT,
  created_by TEXT REFERENCES staff_users(id),
  created_at TEXT NOT NULL,
  UNIQUE (category, external_event_id)
);

CREATE INDEX idx_money_movements_order_status ON money_movements(order_id, status);
CREATE INDEX idx_money_movements_occurred_at ON money_movements(occurred_at);

CREATE TABLE order_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES staff_users(id),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_order_events_order_created ON order_events(order_id, created_at);

CREATE TABLE automation_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  trigger_event TEXT NOT NULL,
  conditions_json TEXT NOT NULL DEFAULT '{}',
  action_type TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'review' CHECK (mode IN ('review', 'live')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  responsible_role TEXT NOT NULL DEFAULT 'manager',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE automation_jobs (
  id TEXT PRIMARY KEY,
  rule_id TEXT REFERENCES automation_rules(id),
  order_id TEXT REFERENCES orders(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  action_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'review', 'done', 'failed', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_after TEXT NOT NULL,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_automation_jobs_ready ON automation_jobs(status, run_after);
CREATE INDEX idx_automation_jobs_order_id ON automation_jobs(order_id);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  signature_valid INTEGER NOT NULL CHECK (signature_valid IN (0, 1)),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (provider, provider_event_id)
);

PRAGMA optimize;
