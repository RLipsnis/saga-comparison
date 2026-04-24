#!/bin/bash
# ============================================================================
# Resource Scaling Test
# ============================================================================
# Tests how giving more/fewer resources to Temporal and RabbitMQ affects
# saga execution time under load.
#
# This script:
#   1. Starts infrastructure with specific resource limits
#   2. Waits for services to be healthy
#   3. Runs k6 load tests
#   4. Captures Docker container stats (CPU/RAM) during the test
#   5. Saves results for comparison
#
# Prerequisites:
#   brew install k6 jq
#   .NET services must be started manually after infra is up
#
# Usage:
#   ./run-resource-scaling-test.sh <mode> <profile>
#   ./run-resource-scaling-test.sh orchestration constrained
#   ./run-resource-scaling-test.sh choreography generous
#
# Profiles: constrained, default, generous, unlimited
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

# Define resource profiles
case "$PROFILE" in
  constrained)
    export TEMPORAL_CPUS=0.5 TEMPORAL_MEMORY=256M
    export RABBITMQ_CPUS=0.5 RABBITMQ_MEMORY=256M
    export POSTGRES_CPUS=0.5 POSTGRES_MEMORY=256M
    ;;
  default)
    export TEMPORAL_CPUS=1.0 TEMPORAL_MEMORY=512M
    export RABBITMQ_CPUS=1.0 RABBITMQ_MEMORY=512M
    export POSTGRES_CPUS=1.0 POSTGRES_MEMORY=512M
    ;;
  generous)
    export TEMPORAL_CPUS=2.0 TEMPORAL_MEMORY=1024M
    export RABBITMQ_CPUS=2.0 RABBITMQ_MEMORY=1024M
    export POSTGRES_CPUS=2.0 POSTGRES_MEMORY=1024M
    ;;
  unlimited)
    # No resource file — use base docker-compose only
    ;;
  *)
    echo "Unknown profile: $PROFILE (use constrained|default|generous|unlimited)"
    exit 1
    ;;
esac

echo "============================================"
echo "  Resource Scaling Test"
echo "  Mode:     $MODE"
echo "  Profile:  $PROFILE"
echo "  Rate:     $RATE req/s"
echo "  Duration: $DURATION"
echo "============================================"

# ── Step 1: Restart infrastructure with resource limits ──
echo ""
echo ">>> Step 1: Starting infrastructure with profile=$PROFILE..."

if [[ "$PROFILE" == "unlimited" ]]; then
  docker compose -f "$PROJECT_DIR/docker-compose.yml" up -d postgres rabbitmq temporal temporal-ui prometheus grafana cadvisor
else
  docker compose \
    -f "$PROJECT_DIR/docker-compose.yml" \
    -f "$PROJECT_DIR/docker-compose.resource-test.yml" \
    up -d postgres rabbitmq temporal temporal-ui prometheus grafana cadvisor
fi

echo "  Waiting for services to stabilize..."
sleep 15

# ── Step 2: Verify health ──
echo ""
echo ">>> Step 2: Checking infrastructure health..."

for i in {1..30}; do
  PG_OK=$(docker exec saga-postgres pg_isready -U saga -d sagadb 2>/dev/null && echo "yes" || echo "no")
  if [[ "$PG_OK" == "yes" ]]; then break; fi
  sleep 2
done
echo "  PostgreSQL: $PG_OK"

RMQ_OK=$(docker exec saga-rabbitmq rabbitmq-diagnostics -q ping 2>/dev/null && echo "yes" || echo "no")
echo "  RabbitMQ:   $RMQ_OK"

# ── Step 3: Capture pre-test container stats ──
echo ""
echo ">>> Step 3: Capturing pre-test resource baseline..."

docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}" \
  saga-temporal saga-rabbitmq saga-postgres 2>/dev/null | tee "$RESULTS_DIR/stats_pre_${MODE}_${PROFILE}_${TIMESTAMP}.txt"

# ── Step 4: Start background resource monitoring ──
echo ""
echo ">>> Step 4: Starting background resource monitoring..."
STATS_LOG="$RESULTS_DIR/stats_during_${MODE}_${PROFILE}_${TIMESTAMP}.csv"
echo "timestamp,container,cpu_pct,mem_usage,mem_limit,net_in,net_out" > "$STATS_LOG"

# Sample docker stats every 2 seconds during the test
(
  while true; do
    TS=$(date +%s)
    docker stats --no-stream --format "{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.NetIO}}" \
      saga-temporal saga-rabbitmq saga-postgres 2>/dev/null | while IFS=',' read -r name cpu mem net; do
        mem_usage=$(echo "$mem" | cut -d'/' -f1 | xargs)
        mem_limit=$(echo "$mem" | cut -d'/' -f2 | xargs)
        net_in=$(echo "$net" | cut -d'/' -f1 | xargs)
        net_out=$(echo "$net" | cut -d'/' -f2 | xargs)
        echo "$TS,$name,$cpu,$mem_usage,$mem_limit,$net_in,$net_out" >> "$STATS_LOG"
    done
    sleep 2
  done
) &
STATS_PID=$!

# ── Step 5: Run load test ──
echo ""
echo ">>> Step 5: Running k6 load test..."
echo "  NOTE: Ensure .NET services are running with SagaMode=$MODE"
echo ""

# Reset state
curl -s -X POST "$BASE_URL/api/inventory/reset" > /dev/null 2>&1 || true
curl -s -X DELETE "$BASE_URL/api/orders/reset" > /dev/null 2>&1 || true
sleep 2

RESULT_FILE="$RESULTS_DIR/k6_${MODE}_${PROFILE}_${RATE}rps_${TIMESTAMP}.json"

k6 run \
  --env RATE="$RATE" \
  --env DURATION="$DURATION" \
  --env BASE_URL="$BASE_URL" \
  --env MODE="${MODE}_${PROFILE}" \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  "$SCRIPT_DIR/benchmark-saga-steps.js" \
  2>&1 | tee "$RESULTS_DIR/k6_log_${MODE}_${PROFILE}_${RATE}rps_${TIMESTAMP}.txt"

# Copy the k6 JSON result if it was created
if [[ -f "$SCRIPT_DIR/results/steps_${MODE}_${PROFILE}_${RATE}rps.json" ]]; then
  cp "$SCRIPT_DIR/results/steps_${MODE}_${PROFILE}_${RATE}rps.json" "$RESULT_FILE"
fi

# ── Step 6: Stop monitoring, capture post-test stats ──
kill $STATS_PID 2>/dev/null || true

echo ""
echo ">>> Step 6: Capturing post-test resource stats..."
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}" \
  saga-temporal saga-rabbitmq saga-postgres 2>/dev/null | tee "$RESULTS_DIR/stats_post_${MODE}_${PROFILE}_${TIMESTAMP}.txt"

# ── Step 7: Summary ──
echo ""
echo "============================================"
echo "  Test Complete"
echo "  Mode:    $MODE"
echo "  Profile: $PROFILE ($TEMPORAL_CPUS CPUs / $TEMPORAL_MEMORY RAM)"
echo "  Results: $RESULTS_DIR/"
echo ""
echo "  Files generated:"
echo "    - stats_pre_*   : Container stats before test"
echo "    - stats_during_*: CPU/RAM samples every 2s during test"
echo "    - stats_post_*  : Container stats after test"
echo "    - k6_log_*      : k6 console output with percentiles"
echo "    - k6_*.json     : Structured results with P95/P99"
echo "============================================"
