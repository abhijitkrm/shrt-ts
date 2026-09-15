#!/usr/bin/env bash
# Self-contained CLI smoke test: boots a temp server, exercises the API, kills it.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4567}"
DIR="$(mktemp -d)"
BASE="http://127.0.0.1:$PORT"

DATA_DIR="$DIR" PORT="$PORT" SERVER=uws node dist/index.js >/tmp/urlshort-smoke.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$DIR"' EXIT

for i in $(seq 1 50); do curl -sf "$BASE/api/health" >/dev/null 2>&1 && break; sleep 0.1; done

echo "== health =="
curl -s "$BASE/api/health"; echo

echo "== POST /api/shorten =="
curl -s -X POST "$BASE/api/shorten" -H 'content-type: application/json' \
  -d '{"url":"https://devin.ai/docs"}'; echo

echo "== GET /{code} (302) =="
curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" "$BASE/1"

echo "== POST /api/shorten with alias =="
curl -s -X POST "$BASE/api/shorten" -H 'content-type: application/json' \
  -d '{"url":"https://github.com/cognitionai","alias":"gh"}'; echo
curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" "$BASE/gh"

echo "== duplicate alias (409) =="
curl -s -w " [%{http_code}]" -X POST "$BASE/api/shorten" -H 'content-type: application/json' \
  -d '{"url":"https://other.com","alias":"gh"}'; echo

echo "== POST /api/shorten/bulk =="
curl -s -X POST "$BASE/api/shorten/bulk" -H 'content-type: application/json' \
  -d '{"urls":["https://a.com","https://b.com","https://c.com"]}'; echo

echo "== GET /api/stats/1 (shows hit count) =="
curl -s "$BASE/api/stats/1"; echo

echo "== ttl_ms=1 link -> expires =="
TTL_CODE=$(curl -s -X POST "$BASE/api/shorten" -H 'content-type: application/json' \
  -d '{"url":"https://gone.com","ttl_ms":1}' | sed -E 's/.*"code":"([^"]+)".*/\1/')
echo "code=$TTL_CODE"
sleep 0.05
curl -s -o /dev/null -w "after ttl: %{http_code}\n" "$BASE/$TTL_CODE"

echo "== 404 / 400 cases =="
curl -s -o /dev/null -w "unknown code: %{http_code}\n" "$BASE/zzzz"
curl -s -o /dev/null -w "bad url:      %{http_code}\n" -X POST "$BASE/api/shorten" \
  -H 'content-type: application/json' -d '{"url":"notaurl"}'

echo
echo "log dir contents:"; ls "$DIR"
