#!/usr/bin/env bash

# Spins up wrangler locally, seeds a poll, and prints the SPA URL to vote/view results.
# Leaves wrangler running so you can interact via the browser until you Ctrl+C.

set -euo pipefail

PORT="${PORT:-8787}"
WORKER_URL="http://127.0.0.1:${PORT}"
LOG_FILE="${LOG_FILE:-/tmp/stu-workers-wrangler.log}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    exit 1
  fi
}

require_cmd npx
require_cmd curl

# Resolve MASTER_KEY (env -> .env -> wrangler.toml)
ENV_MASTER_KEY="${MASTER_KEY-}"
DOTENV_MASTER_KEY=""
if [ -z "${ENV_MASTER_KEY}" ] && [ -f ".env" ]; then
  DOTENV_MASTER_KEY=$(grep -E '^MASTER_KEY=' .env | tail -n1 | cut -d= -f2-)
fi
WRANGLER_MASTER_KEY=$(node -e "const fs = require('fs'); const toml = fs.readFileSync('wrangler.toml','utf8'); const m = toml.match(/MASTER_KEY\\s*=\\s*\"([^\"]+)\"/); console.log(m ? m[1] : '');" 2>/dev/null || echo "")
MASTER_KEY="${ENV_MASTER_KEY:-${DOTENV_MASTER_KEY:-${WRANGLER_MASTER_KEY}}}"
if [ -z "${MASTER_KEY}" ]; then
  echo "MASTER_KEY not set. Set MASTER_KEY in your env, .env, or wrangler.toml."
  exit 1
fi

echo "Starting wrangler dev on ${WORKER_URL} (logs: ${LOG_FILE})..."
ENVIRONMENT=development NODE_ENV=development NODE_OPTIONS="" \
  npx wrangler dev \
    --local \
    --port "${PORT}" \
    --persist-to .wrangler/state \
    --var ENVIRONMENT=development \
    --var NODE_ENV=development \
    --var MASTER_KEY="${MASTER_KEY}" \
    >"${LOG_FILE}" 2>&1 &
WRANGLER_PID=$!
trap 'echo "Stopping wrangler dev (pid ${WRANGLER_PID})"; kill "${WRANGLER_PID}" >/dev/null 2>&1' EXIT

echo -n "Waiting for worker to boot"
for _ in {1..60}; do
  if curl -sf "${WORKER_URL}/status" >/dev/null 2>&1; then
    echo " ... ready."
    break
  fi
  echo -n "."
  sleep 0.5
done

# Build a valid API key using the same scheme as validateApiKey.js
API_KEY=$(MASTER_KEY="${MASTER_KEY}" node - <<'NODE'
const crypto = require('crypto');
const master = process.env.MASTER_KEY;
if (!master) {
  console.error('MASTER_KEY is missing, cannot build API key.');
  process.exit(1);
}
const random = crypto.randomBytes(4).toString('hex');
const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0,10); // yyyy-MM-dd
const keyContent = `stucal_${random}_${expiry}`;
const signature = crypto.createHmac('sha256', master.slice(0,3)).update(keyContent).digest('hex').slice(0,8);
console.log(`${keyContent}_${signature}`);
NODE
)

CREATE_PAYLOAD='{
  "question": "Who is the joker of the office?",
  "durationSeconds": 30,
  "options": [
    { "name": "Pizza", "url": "https://example.com/pizza" },
    { "name": "Sushi", "url": "https://example.com/sushi" },
    { "name": "Tacos", "url": "https://example.com/tacos" }
  ],
  "open": "2025-01-01T18:00:00Z",
  "close": "2027-01-01T20:00:00Z"
}'

echo "Creating poll..."
create_response=$(curl -sS -X POST "${WORKER_URL}/poll/new" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${API_KEY}" \
  -d "${CREATE_PAYLOAD}")

poll_id=$(echo "${create_response}" | node -e "const d = JSON.parse(require('fs').readFileSync(0, 'utf8')); console.log(d.id || '');")
if [ -z "${poll_id}" ]; then
  echo "Failed to create poll. Response was:"
  echo "${create_response}"
  exit 1
fi

SPA_URL="${WORKER_URL}/poll/app?id=${poll_id}"
ADMIN_URL="${WORKER_URL}/poll/admin/spa?key=${API_KEY}"
echo "Poll created: ${poll_id}"
echo "Open the SPA to vote/view results:"
echo "  ${SPA_URL}"
echo "Admin SPA (requires API key in query):"
echo "  ${ADMIN_URL}"
echo "Wrangler is running. Press Ctrl+C to stop."

# Keep process alive so the SPA stays reachable
wait "${WRANGLER_PID}"
