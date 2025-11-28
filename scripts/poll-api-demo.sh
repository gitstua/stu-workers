#!/usr/bin/env bash

# Demonstrates calling the poll API against a local wrangler dev instance.
# Spins up wrangler in the background, creates a poll, votes, and prints the results.

set -euo pipefail

PORT="${PORT:-8787}"
WORKER_URL="http://127.0.0.1:${PORT}"
LOG_FILE="${LOG_FILE:-/tmp/stu-workers-wrangler.log}"

# Load MASTER_KEY before starting wrangler (env -> .env -> wrangler.toml)
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

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required but not installed (comes with Node.js >= v8)."
  exit 1
fi

echo "Starting wrangler dev on ${WORKER_URL} (logs: ${LOG_FILE})..."
ENVIRONMENT=development NODE_ENV=development \
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
for _ in {1..20}; do
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
echo "Using generated API key for demo."

CREATE_PAYLOAD='{
  "question": "What should we have for dinner?",
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
echo "Poll created with id: ${poll_id}"

echo "Casting sample votes (showing duplicate rejection)..."
vote_with_identity() {
  local option=$1
  local ip=$2
  local ua=$3
  local label=$4
  echo "  ${label}"
  curl -sS -w ' (status %{http_code})\n' -X POST "${WORKER_URL}/poll/vote" \
    -H "Content-Type: application/json" \
    -H "X-Forwarded-For: ${ip}" \
    -H "User-Agent: ${ua}" \
    -d "{\"pollId\":\"${poll_id}\",\"optionIndex\":${option}}" \
    | sed 's/^/    /'
}

vote_with_identity 1 "203.0.113.10" "Demo-UA-A/1.0" "First vote from fingerprint A (expect success)"
vote_with_identity 2 "203.0.113.10" "Demo-UA-A/1.0" "Second vote from fingerprint A (expect already voted 409)"
vote_with_identity 0 "203.0.113.20" "Demo-UA-B/1.0" "Vote from fingerprint B (different IP/UA, expect success)"

echo ""
echo "Fetching current poll results..."
curl -sS "${WORKER_URL}/poll/results/json?id=${poll_id}" | sed 's/^/  /'
echo ""

echo "Resetting poll via /poll/reset (authenticated)..."
curl -sS -X POST "${WORKER_URL}/poll/reset" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${API_KEY}" \
  -d "{\"pollId\":\"${poll_id}\"}" | sed 's/^/  /'

echo ""
echo "Results after reset (should be zeroed, new open/close):"
curl -sS "${WORKER_URL}/poll/results/json?id=${poll_id}" | sed 's/^/  /'
echo ""
