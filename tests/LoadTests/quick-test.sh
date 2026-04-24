#!/bin/bash
# Quick single-rate test
# Usage: ./quick-test.sh <rate> [duration]
# Example: ./quick-test.sh 10 30s

RATE=${1:-1}
DURATION=${2:-30s}
BASE_URL=${BASE_URL:-http://localhost:5005}

echo "Running $RATE orders/sec for $DURATION against $BASE_URL"

k6 run \
    --env RATE="$RATE" \
    --env DURATION="$DURATION" \
    --env BASE_URL="$BASE_URL" \
    --env MODE="manual" \
    --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
    "$(dirname "$0")/order-load-test.js"
