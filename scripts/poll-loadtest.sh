#!/usr/bin/env bash

# Spins up wrangler dev (local), creates a sample poll, prints the SPA URL,
# then submits 100 random votes while you watch live in the browser.
# Usage: MASTER_KEY must be set (env/.env/wrangler.toml). Optionally set PORT/WORKER_URL.

set -euo pipefail

PORT="${PORT:-8787}"
WORKER_URL="${WORKER_URL:-http://127.0.0.1:${PORT}}"
LOG_FILE="${LOG_FILE:-/tmp/stu-workers-wrangler.log}"

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
const random = crypto.randomBytes(4).toString('hex');
const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0,10);
const keyContent = `stucal_${random}_${expiry}`;
const signature = crypto.createHmac('sha256', master.slice(0,3)).update(keyContent).digest('hex').slice(0,8);
console.log(`${keyContent}_${signature}`);
NODE
)

CREATE_PAYLOAD='{
  "question": "Load test: favorite lunch?",
  "durationSeconds": 30,
  "options": [
    { "name": "Pizza", "url": "" },
    { "name": "Sushi", "url": "" },
    { "name": "Salad", "url": "" }
  ]
}'

echo "Creating poll..."
create_response=$(curl -sS -X POST "${WORKER_URL}/poll/new" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${API_KEY}" \
  -d "${CREATE_PAYLOAD}")

POLL_ID=$(echo "${create_response}" | node -e "const d = JSON.parse(require('fs').readFileSync(0, 'utf8')); console.log(d.id || '');")
if [ -z "${POLL_ID}" ]; then
  echo "Failed to create poll. Response was:"
  echo "${create_response}"
  exit 1
fi

echo "Poll created: ${POLL_ID}"
echo "Watch live: ${WORKER_URL}/poll/app?id=${POLL_ID}"
echo "Admin:      ${WORKER_URL}/poll/admin/spa?key=${API_KEY}"

echo "Loading poll metadata from ${WORKER_URL}/poll/results/json?id=${POLL_ID}"
poll_json=$(curl -sS "${WORKER_URL}/poll/results/json?id=${POLL_ID}" || true)
if [ -z "${poll_json}" ]; then
  echo "Failed to load poll data."
  exit 1
fi

option_count=$(echo "${poll_json}" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.options ? d.options.length : 0);")
if [ "${option_count}" -le 0 ]; then
  echo "No options found for poll ${POLL_ID}"
  exit 1
fi
end_ts=$(echo "${poll_json}" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); const close=d.close?Date.parse(d.close):Date.now()+((d.durationSeconds||30)*1000); console.log(close);")

echo "Poll has ${option_count} options."
sent=0
max_votes=1000
end_wall=$(( $(date +%s) + 30 ))
while :; do
  now_s=$(date +%s)
  if [ "${now_s}" -ge "${end_wall}" ] && [ "${sent}" -ge 100 ]; then
    echo "Reached minimum duration (30s) and 100 votes; stopping."
    break
  fi

  now_ms=$(node -e "console.log(Date.now());")
  if [ "${now_ms}" -ge "${end_ts}" ]; then
    echo "Poll closed (end reached). Sent ${sent} votes."
    break
  fi

  idx=$((RANDOM % option_count))
  ip_octet=$(( (sent % 200) + 10 ))
  ua="LoadTest/${sent}"
  resp=$(curl -sS -X POST "${WORKER_URL}/poll/vote" \
    -H "Content-Type: application/json" \
    -H "X-Forwarded-For: 203.0.113.${ip_octet}" \
    -H "User-Agent: ${ua}" \
    -d "{\"pollId\":\"${POLL_ID}\",\"optionIndex\":${idx}}")
  if echo "${resp}" | grep -qi "error"; then
    echo "[$((sent+1))] vote failed (option ${idx}): ${resp}"
  else
    sent=$((sent+1))
    echo "[$sent] voted option ${idx}"
  fi
  sleep 0.05
done

echo "Done. Check results at ${WORKER_URL}/poll/app?id=${POLL_ID}"
