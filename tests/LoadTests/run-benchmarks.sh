#!/bin/bash
# Run load tests at increasing rates for both saga modes
# Usage: ./run-benchmarks.sh [orchestration|choreography|both]
#
# Prerequisites:
#   brew install k6
#   All services + docker must be running
#   Reset inventory before each mode: curl -X POST http://localhost:5005/api/inventory/reset

set -e

MODE=${1:-both}
BASE_URL=${BASE_URL:-http://localhost:5005}
DURATION=${DURATION:-60s}
RATES=(1 5 10 25 50 100 250 500 1000)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$SCRIPT_DIR/results"

run_test() {
    local mode=$1
    local rate=$2
    echo ""
    echo "============================================"
    echo "  Mode: $mode | Rate: ${rate} orders/sec | Duration: $DURATION"
    echo "============================================"

    # Reset inventory between runs
    curl -s -X POST "$BASE_URL/api/inventory/reset" > /dev/null 2>&1 || true
    curl -s -X DELETE "$BASE_URL/api/orders/reset" > /dev/null 2>&1 || true
    sleep 2

    k6 run \
        --env RATE="$rate" \
        --env DURATION="$DURATION" \
        --env BASE_URL="$BASE_URL" \
        --env MODE="$mode" \
        --summary-trend-stats="count,avg,min,med,max,p(90),p(95),p(99)" \
        "$SCRIPT_DIR/order-load-test.js" \
        2>&1 | tee "$SCRIPT_DIR/results/log_${mode}_${rate}rps.txt"

    echo "  Cooling down for 5 seconds..."
    sleep 5
}

echo "========================================"
echo "  Saga Comparison Load Test Suite"
echo "  Base URL: $BASE_URL"
echo "  Duration per test: $DURATION"
echo "  Rates: ${RATES[*]}"
echo "========================================"

if [[ "$MODE" == "orchestration" || "$MODE" == "both" ]]; then
    echo ""
    echo ">>> Starting ORCHESTRATION tests <<<"
    echo ">>> Make sure all services have SagaMode=orchestration <<<"
    if [[ "$MODE" == "both" ]]; then
        read -p "Press ENTER when all services are running in orchestration mode..."
    fi
    for rate in "${RATES[@]}"; do
        run_test "orchestration" "$rate"
    done
fi

if [[ "$MODE" == "choreography" || "$MODE" == "both" ]]; then
    echo ""
    echo ">>> Starting CHOREOGRAPHY tests <<<"
    echo ">>> Make sure all services have SagaMode=choreography <<<"
    if [[ "$MODE" == "both" ]]; then
        read -p "Press ENTER when all services are running in choreography mode..."
    fi
    for rate in "${RATES[@]}"; do
        run_test "choreography" "$rate"
    done
fi

echo ""
echo "========================================"
echo "  All tests complete!"
echo "  Results in: $SCRIPT_DIR/results/"
echo "========================================"
