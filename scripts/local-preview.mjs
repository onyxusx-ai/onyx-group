import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import worker from '../src/index.mjs';
import { TestD1 } from '../tests/d1-test-adapter.mjs';

const port = Number(process.env.ONYX_PREVIEW_PORT || 8787);
const databasePath = path.resolve(process.env.ONYX_PREVIEW_DB || '.dev/preview.sqlite');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const databaseExists = fs.existsSync(databasePath);
const DB = new TestD1(databasePath);
if (!databaseExists) DB.migrate(path.resolve('migrations/0001_ops_mvp.sql'));

const env = {
  DB,
  SETUP_TOKEN: process.env.ONYX_PREVIEW_SETUP_TOKEN || '',
  ADMIN_TOKEN: process.env.ONYX_PREVIEW_ADMIN_TOKEN || '',
  ALLOWED_ORIGINS: `http://localhost:${port},http://127.0.0.1:${port}`,
};

const server = http.createServer(async (incoming, outgoing) => {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const url = `http://${incoming.headers.host || `localhost:${port}`}${incoming.url || '/'}`;
  const request = new Request(url, {
    method: incoming.method,
    headers: incoming.headers,
    body: ['GET', 'HEAD'].includes(incoming.method || 'GET') ? undefined : body,
  });
  const pending = [];
  const response = await worker.fetch(request, env, { waitUntil(promise) { pending.push(Promise.resolve(promise)); } });
  const headers = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  outgoing.writeHead(response.status, headers);
  outgoing.end(Buffer.from(await response.arrayBuffer()));
  Promise.allSettled(pending).catch(() => {});
});

server.listen(port, '127.0.0.1', () => {
  console.log(`ONYX local preview: http://localhost:${port}/admin`);
  console.log(`Database: ${databasePath}`);
});

function shutdown() {
  server.close(() => {
    DB.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
