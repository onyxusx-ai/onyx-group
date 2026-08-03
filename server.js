const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 5000;
const ADMIN_KEY = process.env.ADMIN_KEY || "2026";
const DB_FILE = path.join(__dirname, "data", "orders.json");

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

function readOrders() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeOrders(orders) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(orders, null, 2), "utf8");
}

app.get("/api/tracking/:code", (req, res) => {
  const code = String(req.params.code || "").trim().toUpperCase();
  const order = readOrders()[code];
  if (!order) return res.status(404).json({ ok: false, error: "not_found" });
  res.json(order);
});

app.post("/api/tracking", (req, res) => {
  if (req.get("X-Admin-Key") !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const order = req.body || {};
  const code = String(order.code || "").trim().toUpperCase();
  const step = Number(order.step);

  if (!/^ONYX-[A-Z0-9-]{3,20}$/.test(code) || !Number.isInteger(step) || step < 1 || step > 5) {
    return res.status(400).json({ ok: false, error: "invalid_order" });
  }

  const orders = readOrders();
  orders[code] = {
    code,
    step,
    status: String(order.status || "Статус обновлён"),
    location: String(order.location || "Уточняется"),
    next: String(order.next || "Уточняется"),
    eta: String(order.eta || "Уточняется"),
    updatedAt: new Date().toISOString()
  };
  writeOrders(orders);
  res.json(orders[code]);
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "ONYX GROUP tracking" }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(PORT, () => console.log(`ONYX GROUP: http://localhost:${PORT}`));
