const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 5000);
const ADMIN_KEY = process.env.ADMIN_KEY || '2026';
const ORDERS_FILE = path.join(ROOT, 'data', 'orders.json');
const REQUESTS_FILE = path.join(ROOT, 'data', 'order-requests.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('payload_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function safeStaticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const resolved = path.resolve(ROOT, relative);
  return resolved === ROOT || resolved.startsWith(ROOT + path.sep) ? resolved : null;
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    res.end();
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true, service: 'ONYX GROUP tracking and requests' });
    return true;
  }

  const trackMatch = url.pathname.match(/^\/api\/tracking\/([^/]+)$/);
  if (req.method === 'GET' && trackMatch) {
    const code = trackMatch[1].trim().toUpperCase();
    const order = readJson(ORDERS_FILE, {})[code];
    sendJson(res, order ? 200 : 404, order || { ok: false, error: 'not_found' });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/tracking') {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return true;
    }
    const body = await readBody(req);
    const code = String(body.code || '').trim().toUpperCase();
    const step = Number(body.step);
    if (!/^ONYX-[A-Z0-9-]{3,20}$/.test(code) || !Number.isInteger(step) || step < 1 || step > 5) {
      sendJson(res, 400, { ok: false, error: 'invalid_order' });
      return true;
    }
    const orders = readJson(ORDERS_FILE, {});
    orders[code] = {
      code,
      step,
      status: String(body.status || 'Статус обновлён'),
      location: String(body.location || 'Уточняется'),
      next: String(body.next || 'Уточняется'),
      eta: String(body.eta || 'Уточняется'),
      updatedAt: new Date().toISOString()
    };
    writeJson(ORDERS_FILE, orders);
    sendJson(res, 200, orders[code]);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/order-requests') {
    const body = await readBody(req);
    const message = String(body.message || '').trim();
    if (!message || message.length > 12_000) {
      sendJson(res, 400, { ok: false, error: 'invalid_request' });
      return true;
    }
    const requests = readJson(REQUESTS_FILE, []);
    const request = {
      id: `REQ-${Date.now()}`,
      type: String(body.type || 'individual'),
      customerName: String(body.customerName || ''),
      customerContact: String(body.customerContact || ''),
      productLink: String(body.productLink || ''),
      total: Number(body.total || 0),
      items: Array.isArray(body.items) ? body.items : [],
      message,
      createdAt: new Date().toISOString()
    };
    requests.unshift(request);
    writeJson(REQUESTS_FILE, requests.slice(0, 1000));
    sendJson(res, 201, { ok: true, id: request.id });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/order-requests') {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return true;
    }
    sendJson(res, 200, { ok: true, requests: readJson(REQUESTS_FILE, []) });
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (await handleApi(req, res, url)) return;

    const file = safeStaticPath(url.pathname);
    if (!file) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let target = file;
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      target = path.join(ROOT, 'index.html');
    }

    const ext = path.extname(target).toLowerCase();
    const stat = fs.statSync(target);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    fs.createReadStream(target).pipe(res);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message || 'server_error' });
  }
});

server.listen(PORT, () => console.log(`ONYX GROUP: http://localhost:${PORT}`));
