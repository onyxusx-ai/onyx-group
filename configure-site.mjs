import fs from 'node:fs';
import path from 'node:path';

const workerUrl = String(process.argv[2] || '').trim().replace(/\/+$/, '');
if (!/^https:\/\//.test(workerUrl)) {
  console.error('Использование: node scripts/configure-site.mjs https://your-worker.workers.dev');
  process.exit(1);
}

const configPath = path.resolve('site/config.js');
const content = fs.readFileSync(configPath, 'utf8');
const next = content.replace(/API_BASE:\s*"[^"]*"/, `API_BASE: "${workerUrl}"`);
if (next === content) {
  console.error('Не удалось найти API_BASE в site/config.js');
  process.exit(1);
}
fs.writeFileSync(configPath, next);
console.log(`site/config.js настроен: ${workerUrl}`);
