#!/bin/bash
# ============================================================================
# Unified Test Runner
# ============================================================================
#
# Single entry point for all saga comparison benchmarks.
# Auto-detects the current SagaMode from the running services.
#
# Usage:
#   ./run-test.sh <test>                          # run with defaults
#   ./run-test.sh <test> --env RATE=25            # pass k6 options
#   ./run-test.sh all                             # run all tests sequentially
#
# Tests:
#   steps         — Full saga + per-step timing breakdown
#   load          — Fire-and-forget API throughput
#   consistency   — Inventory visibility lag
#   idempotency   — Double-click deduplication
#   race          — Concurrent orders for 1-stock product
#   concurrent    — Parallel throughput (no contention)
#   endurance     — Sustained load with P95 drift
#   mixed         — Realistic happy + compensation mix
#   cold-start    — Post-restart warm-up penalty
#   compensation  — Compensation correctness verification
#   all           — Run all tests above sequentially
#
# Each test resets database state automatically via setup().
# Results are written to tests/LoadTests/results/
# ============================================================================

set -e

BASE_URL=${BASE_URL:-http://localhost:5005}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Auto-detect mode from running services ──────────────────────────────────
detect_mode() {
  local health
  health=$(curl -sf "$BASE_URL/api/orders/config" 2>/dev/null) || {
    echo "ERROR: Cannot reach OrderService at $BASE_URL/api/orders/config" >&2
    echo "       Are all services running?" >&2
    exit 1
  }
  echo "$health" | grep -o '"sagaMode":"[^"]*"' | cut -d'"' -f4
}

MODE=${MODE:-$(detect_mode)}
echo ""
echo "  Detected SagaMode: $MODE"
echo "  Base URL:          $BASE_URL"
echo ""

# ── Map test name to script file ────────────────────────────────────────────
resolve_script() {
  case "$1" in
    steps)         echo "benchmark-saga-steps.js" ;;
    load)          echo "order-load-test.js" ;;
    consistency)   echo "benchmark-consistency-lag.js" ;;
    idempotency)   echo "benchmark-idempotency.js" ;;
    race)          echo "benchmark-race-condition.js" ;;
    concurrent)    echo "benchmark-concurrent-customers.js" ;;
    endurance)     echo "benchmark-endurance.js" ;;
    mixed)         echo "benchmark-mixed-workload.js" ;;
    cold-start)    echo "benchmark-cold-start.js" ;;
    compensation)  echo "benchmark-compensation-correctness.js" ;;
    *)
      echo "Unknown test: $1" >&2
      echo "Available: steps load consistency idempotency race concurrent endurance mixed cold-start compensation all" >&2
      exit 1
      ;;
  esac
}

# ── Run a single test ───────────────────────────────────────────────────────
run_one() {
  local test_name="$1"
  shift
  local script
  script=$(resolve_script "$test_name")

  echo "════════════════════════════════════════════════════════════════"
  echo "  Running: $test_name ($MODE)"
  echo "════════════════════════════════════════════════════════════════"
  echo ""

  k6 run \
    --env MODE="$MODE" \
    --env BASE_URL="$BASE_URL" \
    --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
    "$@" \
    "$SCRIPT_DIR/$script"

  echo ""
}

# ── Main ────────────────────────────────────────────────────────────────────
mkdir -p "$SCRIPT_DIR/results"

TEST_NAME="${1:?Usage: $0 <test> [k6 options...]}"
shift

if [[ "$TEST_NAME" == "all" ]]; then
  ALL_TESTS=(steps load consistency idempotency race concurrent endurance mixed compensation)
  for t in "${ALL_TESTS[@]}"; do
    run_one "$t" "$@"
    echo "  Cooling down 5s..."
    sleep 5
  done
  echo ""
  echo "  All tests complete. Results in: $SCRIPT_DIR/results/"
else
  run_one "$TEST_NAME" "$@"
fi
