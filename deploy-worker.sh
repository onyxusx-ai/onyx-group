#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if grep -q "REPLACE_AFTER_RUNNING_WRANGLER_D1_CREATE" wrangler.toml; then
  echo "Сначала создай D1: npx wrangler d1 create onyx-group-ops"
  echo "Затем вставь выданный database_id в wrangler.toml."
  exit 1
fi

npm install
npx wrangler login
npx wrangler r2 bucket create onyx-group-storage || true
npx wrangler r2 bucket create onyx-group-storage-dev || true
echo "Задай токен совместимости для импорта из расширения:"
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put SETUP_TOKEN
npm run db:migrate:remote
npm run deploy
