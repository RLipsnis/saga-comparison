#!/bin/bash
# ============================================================================
# Test N — Broker Outage During Rollback
# ============================================================================
#
# Workflow:
#   1. Set payment failure rate to 100% so every order WILL compensate.
#   2. Place ORDERS orders via the API gateway (default 10).
#   3. Sleep WARMUP_MS (default 500ms) so a few sagas start running.
#   4. Stop the relevant broker for the current mode:
#         orchestration → saga-temporal
#         choreography  → saga-rabbitmq
#      (the OTHER broker is irrelevant to that pattern, so killing it would
#      have no effect.)
#   5. Wait BROKER_DOWN_SECS (default 10s).
#   6. Start the broker.
#   7. Poll all orders for RECOVERY_SECS (default 90s) and report:
#        - orders reached terminal state (Completed/Failed)
#        - orders stuck (Pending/Compensating)
#        - inventory leak vs baseline
#   8. Reset payment failure rate.
#
# Expected outcome (the resilience finding):
#   * Orchestration: Temporal restart → server restores workflow state from
#     Postgres history; worker re-attaches; activities re-dispatched. Orders
#     should reach Failed (with the inventory still leaked because of the
#     1-attempt compensation, but that's a separate finding from Test M).
#   * Choreography: RabbitMQ restart → durable queues survive; OrderService
#     reconnects automatically. Pending events are re-delivered. Orders should
#     resume and reach a terminal state, BUT the saga is still bound by the
#     Compensating-state semantics: if Release also has issues, it stalls.
#
# Usage:
#   ./run-broker-outage-test.sh                             # auto-detects mode
#   ORDERS=20 BROKER_DOWN_SECS=5 ./run-broker-outage-test.sh
#
# Output: results/broker-outage_<mode>.txt
# ============================================================================

set -e

BASE_URL=${BASE_URL:-http://localhost:5005}
ORDERS=${ORDERS:-10}
BROKER_DOWN_SECS=${BROKER_DOWN_SECS:-10}
RECOVERY_SECS=${RECOVERY_SECS:-90}
WARMUP_MS=${WARMUP_MS:-500}
PRODUCT_ID="a1111111-1111-1111-1111-111111111111"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p "$RESULTS_DIR"

# ── Auto-detect mode ────────────────────────────────────────────────────────
MODE=${MODE:-$(curl -sf "$BASE_URL/api/orders/config" | grep -o '"sagaMode":"[^"]*"' | cut -d'"' -f4)}
if [[ -z "$MODE" ]]; then
  echo "ERROR: Could not detect SagaMode from $BASE_URL/api/orders/config" >&2
  exit 1
fi

case "$MODE" in
  orchestration) BROKER="saga-temporal" ;;
  choreography)  BROKER="saga-rabbitmq" ;;
  *) echo "Unknown SagaMode: $MODE" >&2; exit 1 ;;
esac

OUT="$RESULTS_DIR/broker-outage_${MODE}.txt"
OUT_TS="$RESULTS_DIR/broker-outage_${MODE}_${TIMESTAMP}.txt"

echo "════════════════════════════════════════════════════════════════"
echo "  Broker Outage Test — mode=$MODE  broker=$BROKER"
echo "  Orders=$ORDERS  Down=${BROKER_DOWN_SECS}s  Recovery=${RECOVERY_SECS}s"
echo "════════════════════════════════════════════════════════════════"

{
  echo "Mode:         $MODE"
  echo "Broker:       $BROKER"
  echo "Orders:       $ORDERS"
  echo "Broker down:  ${BROKER_DOWN_SECS}s"
  echo "Recovery:     ${RECOVERY_SECS}s"
  echo "Started:      $(date -Iseconds)"
  echo ""
} | tee "$OUT"

# ── Reset state + force payment failure ─────────────────────────────────────
echo "[1/7] Resetting state…" | tee -a "$OUT"
curl -sf -X POST "$BASE_URL/api/inventory/reset" >/dev/null
curl -sf -X DELETE "$BASE_URL/api/orders/reset"  >/dev/null
curl -sf -X POST "$BASE_URL/api/payments/failure-rate/100" >/dev/null
sleep 1

# Snapshot baseline
BASELINE_RESERVED=$(curl -sf "$BASE_URL/api/inventory/products" \
  | python3 -c "import json,sys; ps=json.load(sys.stdin); p=[x for x in ps if x['id']=='$PRODUCT_ID'][0]; print(p['reservedQuantity'])")
echo "    Baseline reserved=$BASELINE_RESERVED" | tee -a "$OUT"

# ── Place orders ────────────────────────────────────────────────────────────
echo "[2/7] Placing $ORDERS orders…" | tee -a "$OUT"
ORDER_IDS=()
for i in $(seq 1 "$ORDERS"); do
  RESP=$(curl -sf -X POST "$BASE_URL/api/orders" \
    -H "Content-Type: application/json" \
    -d "{\"customerId\":\"$(uuidgen | tr 'A-Z' 'a-z')\",\"items\":[{\"productId\":\"$PRODUCT_ID\",\"quantity\":1,\"unitPrice\":29.99}]}" || true)
  OID=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('orderId',''))" 2>/dev/null || echo "")
  if [[ -n "$OID" ]]; then
    ORDER_IDS+=("$OID")
  else
    echo "    Order $i failed: $RESP" | tee -a "$OUT"
  fi
done
echo "    Placed ${#ORDER_IDS[@]} orders" | tee -a "$OUT"

# Brief warmup so sagas start running
sleep "$(awk -v ms="$WARMUP_MS" 'BEGIN{print ms/1000}')"

# ── Stop broker ─────────────────────────────────────────────────────────────
echo "[3/7] Stopping $BROKER…" | tee -a "$OUT"
docker stop "$BROKER" >/dev/null
echo "    Stopped at $(date -Iseconds)" | tee -a "$OUT"

# Snapshot orders during outage
echo "[4/7] Order statuses DURING outage (after ${BROKER_DOWN_SECS}s):" | tee -a "$OUT"
sleep "$BROKER_DOWN_SECS"
DURING=$(curl -sf "$BASE_URL/api/orders/recent?limit=200" \
  | python3 -c "
import json, sys
orders = json.load(sys.stdin)
hist = {}
for o in orders:
    hist[o['status']] = hist.get(o['status'], 0) + 1
print(json.dumps(hist))" 2>/dev/null || echo '{}')
echo "    $DURING" | tee -a "$OUT"

# ── Restart broker ──────────────────────────────────────────────────────────
echo "[5/7] Starting $BROKER…" | tee -a "$OUT"
docker start "$BROKER" >/dev/null

# Wait for the broker to come back up
case "$BROKER" in
  saga-rabbitmq)
    until docker exec saga-rabbitmq rabbitmq-diagnostics -q ping >/dev/null 2>&1; do sleep 1; done ;;
  saga-temporal)
    until curl -sf http://localhost:8080/api/v1/namespaces >/dev/null 2>&1; do sleep 1; done ;;
esac
echo "    Back up at $(date -Iseconds)" | tee -a "$OUT"

# ── Recovery polling ────────────────────────────────────────────────────────
echo "[6/7] Polling for ${RECOVERY_SECS}s for orders to settle…" | tee -a "$OUT"
DEADLINE=$(( $(date +%s) + RECOVERY_SECS ))
while [[ $(date +%s) -lt $DEADLINE ]]; do
  PENDING=$(curl -sf "$BASE_URL/api/orders/recent?limit=200" \
    | python3 -c "
import json, sys
orders = json.load(sys.stdin)
n = sum(1 for o in orders if o['status'] not in ('Completed','Failed'))
print(n)" 2>/dev/null || echo "?")
  if [[ "$PENDING" == "0" ]]; then
    echo "    All orders reached terminal state" | tee -a "$OUT"
    break
  fi
  sleep 2
done

# ── Final snapshot ──────────────────────────────────────────────────────────
echo "[7/7] Final state:" | tee -a "$OUT"
FINAL=$(curl -sf "$BASE_URL/api/orders/recent?limit=200" \
  | python3 -c "
import json, sys
orders = json.load(sys.stdin)
hist = {}
for o in orders:
    hist[o['status']] = hist.get(o['status'], 0) + 1
print(json.dumps(hist))" 2>/dev/null || echo '{}')
RESERVED_NOW=$(curl -sf "$BASE_URL/api/inventory/products" \
  | python3 -c "import json,sys; ps=json.load(sys.stdin); p=[x for x in ps if x['id']=='$PRODUCT_ID'][0]; print(p['reservedQuantity'])")

LEAK=$((RESERVED_NOW - BASELINE_RESERVED))

echo "    Order histogram:    $FINAL" | tee -a "$OUT"
echo "    Inventory reserved: $RESERVED_NOW (baseline=$BASELINE_RESERVED, leak=$LEAK)" | tee -a "$OUT"
echo "    Finished:           $(date -Iseconds)" | tee -a "$OUT"

# Reset failure rate
curl -sf -X POST "$BASE_URL/api/payments/failure-rate/0" >/dev/null

cp "$OUT" "$OUT_TS"
echo ""
echo "  Result: $OUT  (also: $OUT_TS)"
