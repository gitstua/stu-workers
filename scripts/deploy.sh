#!/usr/bin/env bash

# Deploy script for stu-workers (wrangler v4).
# - Resolves/creates KV namespaces RATE_LIMIT and POLLS.
# - Updates wrangler.toml with the resolved IDs (preview_id defaults to preview match or prod).
# - Sets required secrets from env if provided (e.g., MASTER_KEY).
# - Publishes the worker.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

REQUIRED_KVS=("RATE_LIMIT" "POLLS")
REQUIRED_SECRETS=("MASTER_KEY")

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    exit 1
  fi
}

require_cmd npx
require_cmd python3
require_cmd node

fetch_kv_list() {
  npx wrangler kv namespace list 2>/dev/null || echo "[]"
}

parse_id() {
  local list="$1" binding="$2" preview="$3"
  echo "${list}" | node -e "
    const binding=process.argv[1], wantPreview=process.argv[2]==='1';
    let raw=''; process.stdin.on('data',d=>raw+=d);
    process.stdin.on('end',()=> {
      let data=[];
      try { data=JSON.parse(raw); } catch(e) { const m=raw.match(/\\[.*\\]/s); if(m){ try{data=JSON.parse(m[0]);}catch{}} }
      const matches = data.filter(n=>{
        if(!n.title) return false;
        const t=n.title;
        if (wantPreview) return t.endsWith(binding+'_preview') || t.endsWith(binding+' (preview)') || t.endsWith(binding+'-preview');
        return t===binding || t.endsWith('-'+binding) || t===binding.toLowerCase();
      });
      if(matches.length) { console.log(matches[0].id); return; }
      console.log('');
    });
  " "${binding}" "${preview}"
}

create_namespace() {
  local binding="$1" extra="$2"
  npx wrangler kv namespace create "${binding}" ${extra} 2>/dev/null || true
}

KV_LINES=""

for kv in "${REQUIRED_KVS[@]}"; do
  echo "Ensuring KV namespace: ${kv}"
  kv_list=$(fetch_kv_list)
  prod_id=$(parse_id "${kv_list}" "${kv}" 0)
  preview_id=$(parse_id "${kv_list}" "${kv}" 1)

  if [ -z "${prod_id}" ]; then
    echo "KV ${kv} not found. Attempting to create..."
    create_out=$(create_namespace "${kv}" "--binding=${kv}")
    echo "Create output (truncated):"
    echo "${create_out}" | head -n 10
    kv_list=$(fetch_kv_list)
    prod_id=$(parse_id "${kv_list}" "${kv}" 0)
  fi

  if [ -z "${prod_id}" ]; then
    echo "Failed to resolve id for ${kv}. Current list:"
    echo "${kv_list}" | head -n 50
    exit 1
  fi

  if [ -z "${preview_id}" ]; then
    preview_id="${prod_id}"
  fi

  KV_LINES+="${kv}|${prod_id}|${preview_id}\n"
  echo "${kv}: id=${prod_id}, preview_id=${preview_id}"
done

export KV_DATA="${KV_LINES}"

python3 - <<'PY'
import os, re, pathlib
path = pathlib.Path("wrangler.toml")
txt = path.read_text()
lines = [ln for ln in os.environ["KV_DATA"].splitlines() if ln.strip()]
for ln in lines:
    parts = ln.split("|")
    if len(parts) < 3:
        continue
    name, prod, prev = parts[0], parts[1], parts[2]
    pattern = re.compile(r'(\[\[kv_namespaces\]\][^\[]*?binding\s*=\s*"' + re.escape(name) + r'"[^\[]*?)', re.DOTALL)
    m = pattern.search(txt)
    if not m:
        continue
    block = m.group(1)
    block_new = re.sub(r'(id\s*=\s*")([^"]*)(")', lambda mm: f'{mm.group(1)}{prod}{mm.group(3)}', block, count=1)
    block_new = re.sub(r'(preview_id\s*=\s*")([^"]*)(")', lambda mm: f'{mm.group(1)}{prev}{mm.group(3)}', block_new, count=1)
    txt = txt.replace(block, block_new, 1)
path.write_text(txt)
PY
echo "wrangler.toml updated with KV IDs."

echo "Checking required secrets..."
for sec in "${REQUIRED_SECRETS[@]}"; do
  if [ -z "${!sec:-}" ]; then
    echo "Secret ${sec} not set in env; if needed, run: npx wrangler secret put ${sec}"
  else
    echo "Setting secret ${sec} from environment..."
    set +e
    out=$(printf "%s" "${!sec}" | npx wrangler secret put "${sec}" 2>&1)
    status=$?
    set -e
    if [ ${status} -ne 0 ]; then
      if echo "${out}" | grep -qi "already in use"; then
        echo "Secret ${sec} already exists; leaving as-is."
      else
        echo "Failed to set secret ${sec}:"
        echo "${out}"
        exit 1
      fi
    fi
  fi
done

echo "Deploying worker..."
npx wrangler deploy

echo "Deploy complete."
