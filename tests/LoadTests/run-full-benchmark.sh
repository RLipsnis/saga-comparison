#!/bin/bash
# ============================================================================
# Full Benchmark Matrix
# ============================================================================
# Runs the benchmark-saga-steps test across multiple rates for a given mode,
# producing a complete dataset with percentile metrics for thesis charts.
#
# Usage:
#   ./run-full-benchmark.sh <orchestration|choreography> [rates...]
#
# Examples:
#   ./run-full-benchmark.sh orchestration           # default rates: 1 5 10 25
#   ./run-full-benchmark.sh choreography 1 10 50    # custom rates
#
# Output:
#   results/benchmark_<mode>_summary.json  — aggregated results across rates
#   results/steps_<mode>_<rate>rps.json    — per-rate detailed results
# ============================================================================

set -e

MODE=${1:?Usage: $0 <orchestration|choreography> [rates...]}
shift
RATES=("${@:-1 5 10 25}")
if [ ${#RATES[@]} -eq 0 ]; then RATES=(1 5 10 25); fi

BASE_URL=${BASE_URL:-http://localhost:5005}
DURATION=${DURATION:-30s}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$SCRIPT_DIR/results"

SUMMARY_FILE="$SCRIPT_DIR/results/benchmark_${MODE}_summary.json"
echo "[" > "$SUMMARY_FILE"
FIRST=true

echo "============================================"
echo "  Full Benchmark — $(echo "$MODE" | tr '[:lower:]' '[:upper:]')"
echo "  Rates: ${RATES[*]}"
echo "  Duration per test: $DURATION"
echo "============================================"

for rate in "${RATES[@]}"; do
  echo ""
  echo "────────────────────────────────────────────"
  echo "  Testing: $rate req/s for $DURATION"
  echo "────────────────────────────────────────────"

  # Reset state between runs
  curl -s -X POST "$BASE_URL/api/inventory/reset" > /dev/null 2>&1 || true
  curl -s -X DELETE "$BASE_URL/api/orders/reset" > /dev/null 2>&1 || true
  sleep 3

  k6 run \
    --env RATE="$rate" \
    --env DURATION="$DURATION" \
    --env BASE_URL="$BASE_URL" \
    --env MODE="$MODE" \
    --summary-trend-stats="count,avg,min,med,max,p(90),p(95),p(99)" \
    "$SCRIPT_DIR/benchmark-saga-steps.js"

  # Append to summary if result file exists
  RESULT_FILE="$SCRIPT_DIR/results/steps_${MODE}_${rate}rps.json"
  if [[ -f "$RESULT_FILE" ]]; then
    if [[ "$FIRST" == "true" ]]; then
      FIRST=false
    else
      echo "," >> "$SUMMARY_FILE"
    fi
    cat "$RESULT_FILE" >> "$SUMMARY_FILE"
  fi

  echo "  Cooling down for 5 seconds..."
  sleep 5
done

echo "]" >> "$SUMMARY_FILE"

echo ""
echo "============================================"
echo "  All tests complete!"
echo "  Summary: $SUMMARY_FILE"
echo "============================================"
