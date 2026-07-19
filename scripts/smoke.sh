#!/usr/bin/env bash
set -u

HTTP_BASE="${1:-http://localhost:3005}"
WS_BASE="${2:-http://localhost:8080}"

FAILURES=0
BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT

report() {
  if [ "$2" = "$3" ]; then
    echo "PASS  $1 ($2)"
  else
    echo "FAIL  $1 (expected $3, got $2)"
    FAILURES=$((FAILURES + 1))
  fi
}

STATUS=$(curl -sS -o "$BODY_FILE" -w '%{http_code}' "$HTTP_BASE/health"); STATUS=${STATUS:-000}
report "1. GET $HTTP_BASE/health" "$STATUS" 200

STATUS=$(curl -sS -o "$BODY_FILE" -w '%{http_code}' "$WS_BASE/health"); STATUS=${STATUS:-000}
report "2. GET $WS_BASE/health" "$STATUS" 200

SUFFIX="$(date +%s)$RANDOM"
EMAIL="smoke-${SUFFIX}@example.com"
PASSWORD="Smoke-${SUFFIX}-pw"
USERNAME="smoke${SUFFIX:5:12}"

STATUS=$(curl -sS -o "$BODY_FILE" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USERNAME\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  "$HTTP_BASE/signup"); STATUS=${STATUS:-000}
report "3. POST /signup" "$STATUS" 201

STATUS=$(curl -sS -o "$BODY_FILE" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  "$HTTP_BASE/signin"); STATUS=${STATUS:-000}
report "4. POST /signin" "$STATUS" 200
TOKEN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY_FILE")

STATUS=$(curl -sS -o "$BODY_FILE" -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $TOKEN" \
  "$HTTP_BASE/room"); STATUS=${STATUS:-000}
report "5. POST /room" "$STATUS" 201
SLUG=$(sed -n 's/.*"slug":"\([^"]*\)".*/\1/p' "$BODY_FILE")
ROOM_ID=$(sed -n 's/.*"roomId":\([0-9][0-9]*\).*/\1/p' "$BODY_FILE")

STATUS=$(curl -sS -o "$BODY_FILE" -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" \
  "$HTTP_BASE/room/$SLUG"); STATUS=${STATUS:-000}
report "6. GET /room/$SLUG" "$STATUS" 200

STATUS=$(curl -sS -o "$BODY_FILE" -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" \
  "$HTTP_BASE/operations/$ROOM_ID"); STATUS=${STATUS:-000}
report "7. GET /operations/$ROOM_ID" "$STATUS" 200

if [ "$FAILURES" -gt 0 ]; then
  echo "SMOKE FAILED: $FAILURES step(s) failed"
  exit 1
fi
echo "SMOKE PASSED: all 7 steps"
