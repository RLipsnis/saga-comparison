#!/bin/bash
# ============================================================================
# Test O — Worker Crash Mid-Saga
# ============================================================================
#
# OrderService is the host process for BOTH:
#   * the Temporal worker (orchestration mode)
#   * the MassTransit saga state machine (choreography mode)
# Killing it mid-saga is the harshest single-process failure both patterns
# need to survive.
#
# Workflow:
#   1. Set payment failure rate to 100% so every order WILL compensate.
#   2. Place ORDERS orders (default 10) via the API gateway.
#   3. Sleep WARMUP_MS (default 500ms) so sagas start running.
#   4. docker kill saga-order-service.
#   5. Wait DOWN_SECS (default 5s).
#   6. docker start saga-order-service + wait for /health.
#   7. Poll all orders for RECOVERY_SECS (default 90s) and report final state.
#   8. Reset payment failure rate.
#
# Expected outcome:
#   * Orchestration: Temporal server holds the workflow state durably. When
#     the worker reconnects, Temporal redispatches the activity that was
#     running at crash time. Orders should reach Failed (with compensation
#     leaks per Test M, but they at least reach a terminal state).
#   * Choreography: saga state is in the OrderService's Postgres saga table.
#     The InventoryReserved / PaymentProcessed events are durably queued in
#     RabbitMQ. When OrderService restarts, MassTransit re-attaches and drains
#     the queues, advancing the state machine. Orders should also reach
#     terminal state.
#
# This is one of the strongest comparison points: both should survive, but
# orchestration's "server-managed history" vs choreography's "broker-managed
# at-least-once delivery" are very different recovery mechanisms.
#
# Usage:
#   ./run-worker-crash-test.sh                      # auto-detects mode
#   ORDERS=20 DOWN_SECS=10 ./run-worker-crash-test.sh
#
# Output: results/worker-crash_<mode>.txt
# ============================================================================

set -e

BASE_URL=${BASE_URL:-http://localhost:5005}
ORDERS=${ORDERS:-10}
DOWN_SECS=${DOWN_SECS:-5}
RECOVERY_SECS=${RECOVERY_SECS:-90}
WARMUP_MS=${WARMUP_MS:-500}
PRODUCT_ID="a1111111-1111-1111-1111-111111111111"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p "$RESULTS_DIR"

MODE=${MODE:-$(curl -sf "$BASE_URL/api/orders/config" | grep -o '"sagaMode":"[^"]*"' | cut -d'"' -f4)}
if [[ -z "$MODE" ]]; then
  echo "ERROR: Could not detect SagaMode from $BASE_URL/api/orders/config" >&2
  exit 1
fi

OUT="$RESULTS_DIR/worker-crash_${MODE}.txt"
OUT_TS="$RESULTS_DIR/worker-crash_${MODE}_${TIMESTAMP}.txt"

echo "════════════════════════════════════════════════════════════════"
echo "  Worker Crash Test — mode=$MODE"
echo "  Orders=$ORDERS  Down=${DOWN_SECS}s  Recovery=${RECOVERY_SECS}s"
echo "════════════════════════════════════════════════════════════════"

{
  echo "Mode:         $MODE"
  echo "Orders:       $ORDERS"
  echo "Down:         ${DOWN_SECS}s"
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

BASELINE_RESERVED=$(curl -sf "$BASE_URL/api/inventory/products" \
  | python3 -c "import json,sys; ps=json.load(sys.stdin); p=[x for x in ps if x['id']=='$PRODUCT_ID'][0]; print(p['reservedQuantity'])")
echo "    Baseline reserved=$BASELINE_RESERVED" | tee -a "$OUT"

# ── Place orders ────────────────────────────────────────────────────────────
echo "[2/7] Placing $ORDERS orders…" | tee -a "$OUT"
PLACED=0
for i in $(seq 1 "$ORDERS"); do
  RESP=$(curl -sf -X POST "$BASE_URL/api/orders" \
    -H "Content-Type: application/json" \
    -d "{\"customerId\":\"$(uuidgen | tr 'A-Z' 'a-z')\",\"items\":[{\"productId\":\"$PRODUCT_ID\",\"quantity\":1,\"unitPrice\":29.99}]}" || true)
  if [[ -n "$RESP" ]]; then
    PLACED=$((PLACED + 1))
  fi
done
echo "    Placed $PLACED orders" | tee -a "$OUT"

# Brief warmup
sleep "$(awk -v ms="$WARMUP_MS" 'BEGIN{print ms/1000}')"

# ── Kill OrderService ───────────────────────────────────────────────────────
echo "[3/7] docker kill saga-order-service" | tee -a "$OUT"
docker kill saga-order-service >/dev/null
echo "    Killed at $(date -Iseconds)" | tee -a "$OUT"

# Note: while OrderService is down, /api/orders/recent is unreachable, so we
# don't snapshot during the outage. We just wait.
echo "[4/7] Waiting ${DOWN_SECS}s with worker dead…" | tee -a "$OUT"
sleep "$DOWN_SECS"

# ── Restart OrderService ────────────────────────────────────────────────────
echo "[5/7] docker start saga-order-service" | tee -a "$OUT"
docker start saga-order-service >/dev/null

# Wait for /health to come back
DEADLINE_HEALTH=$(( $(date +%s) + 60 ))
until curl -sf "$BASE_URL/api/orders/config" >/dev/null 2>&1; do
  sleep 1
  if [[ $(date +%s) -gt $DEADLINE_HEALTH ]]; then
    echo "    OrderService never came back up" | tee -a "$OUT"
    exit 1
  fi
done
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
