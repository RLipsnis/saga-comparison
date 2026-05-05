#!/bin/bash
# ============================================================================
# Resource Scaling Test (Test D)
# ============================================================================
# Runs the saga-step k6 benchmark with explicit CPU/RAM limits on
#   * Temporal, RabbitMQ, Postgres   (the saga infrastructure)
#   * order-service, inventory-service, payment-service, shipping-service,
#     notification-service, api-gateway   (where actual saga work runs)
#
# Why both: previously only the infrastructure containers had limits, so most
# of the time the test was actually saga-saturated by Postgres alone. The
# .NET service processes were running outside Docker with no constraints.
# Now everything is in Docker so the only variable is the resource budget.
#
# Usage:
#   ./run-resource-scaling-test.sh <mode> <profile>
#   ./run-resource-scaling-test.sh orchestration constrained
#   ./run-resource-scaling-test.sh choreography  generous   --rate 100
#
# Profiles: constrained, default, generous, unlimited
# Optional flags:
#   RATE=N         (default 10)   k6 arrival rate per second
#   DURATION=Ns    (default 30s)
#   BASE_URL=URL   (default http://localhost:5005, the api-gateway)
# ============================================================================

set -e

MODE=${1:?Usage: $0 <orchestration|choreography> <constrained|default|generous|unlimited>}
PROFILE=${2:?Usage: $0 <orchestration|choreography> <constrained|default|generous|unlimited>}
BASE_URL=${BASE_URL:-http://localhost:5005}
DURATION=${DURATION:-30s}
RATE=${RATE:-10}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results/resource-scaling"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p "$RESULTS_DIR"

# All compose files in one place for reuse below.
COMPOSE_BASE=(-f "$PROJECT_DIR/docker-compose.yml")
COMPOSE_LIMITS=(-f "$PROJECT_DIR/docker-compose.yml" -f "$PROJECT_DIR/docker-compose.resource-test.yml")

# Containers we care about for stats. Built from the compose service names.
INFRA_CONTAINERS=(saga-temporal saga-rabbitmq saga-postgres)
DOTNET_CONTAINERS=(saga-order-service saga-inventory-service saga-payment-service saga-shipping-service saga-notification-service saga-api-gateway)
ALL_CONTAINERS=("${INFRA_CONTAINERS[@]}" "${DOTNET_CONTAINERS[@]}")

# ── Resource profiles ───────────────────────────────────────────────────────
# Both infrastructure AND .NET services scale together.
case "$PROFILE" in
  constrained)
    export TEMPORAL_CPUS=0.5  TEMPORAL_MEMORY=256M
    export RABBITMQ_CPUS=0.5  RABBITMQ_MEMORY=256M
    export POSTGRES_CPUS=0.5  POSTGRES_MEMORY=256M
    export SERVICE_CPUS=0.5   SERVICE_MEMORY=256M
    USE_LIMITS=1
    ;;
  default)
    export TEMPORAL_CPUS=1.0  TEMPORAL_MEMORY=512M
    export RABBITMQ_CPUS=1.0  RABBITMQ_MEMORY=512M
    export POSTGRES_CPUS=1.0  POSTGRES_MEMORY=512M
    export SERVICE_CPUS=1.0   SERVICE_MEMORY=512M
    USE_LIMITS=1
    ;;
  generous)
    export TEMPORAL_CPUS=2.0  TEMPORAL_MEMORY=1024M
    export RABBITMQ_CPUS=2.0  RABBITMQ_MEMORY=1024M
    export POSTGRES_CPUS=2.0  POSTGRES_MEMORY=1024M
    export SERVICE_CPUS=2.0   SERVICE_MEMORY=1024M
    USE_LIMITS=1
    ;;
  unlimited)
    USE_LIMITS=0
    ;;
  *)
    echo "Unknown profile: $PROFILE (use constrained|default|generous|unlimited)"
    exit 1
    ;;
esac

# Saga mode is read by every .NET service as ${SAGA_MODE} via docker-compose.
export SAGA_MODE="$MODE"

# Pick the right compose argv depending on profile.
if [[ "$USE_LIMITS" -eq 1 ]]; then
  COMPOSE_ARGS=("${COMPOSE_LIMITS[@]}")
else
  COMPOSE_ARGS=("${COMPOSE_BASE[@]}")
fi

echo "============================================"
echo "  Resource Scaling Test"
echo "  Mode:     $MODE"
echo "  Profile:  $PROFILE"
echo "  Rate:     $RATE req/s"
echo "  Duration: $DURATION"
echo "  Limits:   $([[ $USE_LIMITS -eq 1 ]] && echo "applied" || echo "none")"
echo "============================================"

# ── Step 1: (Re)build images and start the full stack ──
echo ""
echo ">>> Step 1: Building images + starting stack (mode=$SAGA_MODE, profile=$PROFILE)..."

# Tear down any previous containers so the new resource limits actually apply.
# `--remove-orphans` avoids leftovers if compose service names changed.
docker compose "${COMPOSE_BASE[@]}" down --remove-orphans >/dev/null 2>&1 || true

docker compose "${COMPOSE_ARGS[@]}" build --pull \
  order-service inventory-service payment-service shipping-service notification-service api-gateway

docker compose "${COMPOSE_ARGS[@]}" up -d \
  postgres rabbitmq temporal temporal-ui prometheus grafana cadvisor \
  order-service inventory-service payment-service shipping-service notification-service api-gateway

# ── Step 2: Wait for api-gateway to be healthy (gates on every .NET service) ──
echo ""
echo ">>> Step 2: Waiting for api-gateway healthy (depends_on every .NET service)..."

GATEWAY_OK="no"
for i in {1..60}; do
  if curl -fsS "$BASE_URL/api/orders/config" >/dev/null 2>&1; then
    GATEWAY_OK="yes"
    break
  fi
  sleep 2
done
echo "  ApiGateway reachable: $GATEWAY_OK"

if [[ "$GATEWAY_OK" != "yes" ]]; then
  echo "ERROR: api-gateway did not become healthy in 120s."
  echo "  Check container logs:"
  echo "    docker compose ${COMPOSE_ARGS[*]} logs --tail=100 order-service api-gateway"
  exit 1
fi

# ── Step 3: Capture pre-test container stats ──
echo ""
echo ">>> Step 3: Capturing pre-test resource baseline..."

docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}" \
  "${ALL_CONTAINERS[@]}" 2>/dev/null \
  | tee "$RESULTS_DIR/stats_pre_${MODE}_${PROFILE}_${TIMESTAMP}.txt"

# ── Step 4: Start background resource monitoring ──
echo ""
echo ">>> Step 4: Starting background resource monitoring..."
STATS_LOG="$RESULTS_DIR/stats_during_${MODE}_${PROFILE}_${TIMESTAMP}.csv"
echo "timestamp,container,cpu_pct,mem_usage,mem_limit,net_in,net_out" > "$STATS_LOG"

(
  while true; do
    TS=$(date +%s)
    docker stats --no-stream --format "{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.NetIO}}" \
      "${ALL_CONTAINERS[@]}" 2>/dev/null | while IFS=',' read -r name cpu mem net; do
        mem_usage=$(echo "$mem" | cut -d'/' -f1 | xargs)
        mem_limit=$(echo "$mem" | cut -d'/' -f2 | xargs)
        net_in=$(echo "$net"  | cut -d'/' -f1 | xargs)
        net_out=$(echo "$net" | cut -d'/' -f2 | xargs)
        echo "$TS,$name,$cpu,$mem_usage,$mem_limit,$net_in,$net_out" >> "$STATS_LOG"
    done
    sleep 2
  done
) &
STATS_PID=$!

# Make sure we kill the sampler even on early exit.
trap 'kill $STATS_PID 2>/dev/null || true' EXIT

# ── Step 5: Reset state + run k6 ──
echo ""
echo ">>> Step 5: Resetting state and running k6..."
curl -s -X POST   "$BASE_URL/api/inventory/reset" >/dev/null 2>&1 || true
curl -s -X DELETE "$BASE_URL/api/orders/reset"    >/dev/null 2>&1 || true
sleep 2

RESULT_FILE="$RESULTS_DIR/k6_${MODE}_${PROFILE}_${RATE}rps_${TIMESTAMP}.json"

k6 run \
  --env RATE="$RATE" \
  --env DURATION="$DURATION" \
  --env BASE_URL="$BASE_URL" \
  --env MODE="${MODE}_${PROFILE}" \
  --summary-trend-stats="count,avg,min,med,max,p(90),p(95),p(99)" \
  "$SCRIPT_DIR/benchmark-saga-steps.js" \
  2>&1 | tee "$RESULTS_DIR/k6_log_${MODE}_${PROFILE}_${RATE}rps_${TIMESTAMP}.txt"

# Copy the canonical k6 JSON file (named by k6 itself in handleSummary).
if [[ -f "$SCRIPT_DIR/results/steps_${MODE}_${PROFILE}_${RATE}rps.json" ]]; then
  cp "$SCRIPT_DIR/results/steps_${MODE}_${PROFILE}_${RATE}rps.json" "$RESULT_FILE"
fi

# ── Step 6: Stop monitoring, capture post-test stats ──
kill $STATS_PID 2>/dev/null || true
trap - EXIT

echo ""
echo ">>> Step 6: Capturing post-test resource stats..."
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}" \
  "${ALL_CONTAINERS[@]}" 2>/dev/null \
  | tee "$RESULTS_DIR/stats_post_${MODE}_${PROFILE}_${TIMESTAMP}.txt"

# ── Step 7: Summary ──
echo ""
echo "============================================"
echo "  Test Complete"
echo "  Mode:    $MODE"
echo "  Profile: $PROFILE"
if [[ "$USE_LIMITS" -eq 1 ]]; then
  echo "  Limits:  Infra=${TEMPORAL_CPUS}c/${TEMPORAL_MEMORY}  Service=${SERVICE_CPUS}c/${SERVICE_MEMORY}"
else
  echo "  Limits:  none"
fi
echo "  Results: $RESULTS_DIR/"
echo ""
echo "  Files generated:"
echo "    - stats_pre_*    : Container stats before test"
echo "    - stats_during_* : CPU/RAM samples every 2s during test"
echo "    - stats_post_*   : Container stats after test"
echo "    - k6_log_*       : k6 console output with percentiles"
echo "    - k6_*.json      : Structured results with P95/P99"
echo ""
echo "  Tip: peak CPU during the run lives in stats_during_*.csv,"
echo "       not the post-test snapshot (which is essentially idle)."
echo "============================================"
