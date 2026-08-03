#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../worker"
npm install
npx wrangler login
npx wrangler r2 bucket create onyx-group-storage || true
npx wrangler r2 bucket create onyx-group-storage-dev || true
echo "Задай длинный секретный токен администратора:"
npx wrangler secret put ADMIN_TOKEN
npm run deploy
