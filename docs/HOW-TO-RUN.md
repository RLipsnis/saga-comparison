# How to Run the Project & Perform All Tests

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Architecture Overview](#2-architecture-overview)
3. [Starting Infrastructure (Docker)](#3-starting-infrastructure-docker)
4. [Starting .NET Services](#4-starting-net-services)
5. [Switching Between Orchestration and Choreography](#5-switching-between-orchestration-and-choreography)
6. [Verifying Everything Works](#6-verifying-everything-works)
7. [Test A: Saga Benchmark — end-to-end + per-step (P95)](#7-test-a-saga-benchmark--end-to-end--per-step-p95)
8. [Test B: Fire-and-forget Throughput](#8-test-b-fire-and-forget-throughput)
9. [Test C: Full Benchmark Matrix](#9-test-c-full-benchmark-matrix)
10. [Test D: Resource Scaling (CPU / IO Bottlenecks)](#10-test-d-resource-scaling-cpu--io-bottlenecks)
11. [Test E: Inventory-Visibility Lag](#11-test-e-inventory-visibility-lag)
12. [Test F: Race Condition / Concurrency](#12-test-f-race-condition--concurrency)
13. [Test G: Idempotency](#13-test-g-idempotency)
14. [Test H: Compensation / Failure Benchmark (100% forced fail)](#14-test-h-compensation--failure-benchmark-100-forced-fail)
15. [Test I: Mixed Workload (realistic 10% fail)](#15-test-i-mixed-workload-realistic-10-fail)
16. [Test J: Endurance / Sustained Load](#16-test-j-endurance--sustained-load)
17. [Test K: Concurrent-Customer Throughput](#17-test-k-concurrent-customer-throughput)
18. [Test L: Cold-Start Penalty](#18-test-l-cold-start-penalty)
19. [Monitoring Dashboards](#19-monitoring-dashboards)
20. [Collecting Results for Thesis](#20-collecting-results-for-thesis)
21. [Cleanup](#21-cleanup)

---

## 1. Prerequisites

Install these tools before starting:

```bash
# .NET 8 SDK
dotnet --version   # should be 8.x

# Docker Desktop (must be running)
docker --version
docker compose version

# k6 load testing tool
brew install k6

# Optional: jq for JSON processing
brew install jq
```

---

## 2. Architecture Overview

```
Port Map:
  5005  — API Gateway (YARP reverse proxy)
  5010  — OrderService
  5011  — InventoryService
  5012  — PaymentService
  5013  — ShippingService
  5014  — NotificationService

  5432  — PostgreSQL
  5672  — RabbitMQ (AMQP)
  15672 — RabbitMQ Management UI
  7233  — Temporal Server (gRPC)
  8080  — Temporal UI
  8081  — cAdvisor (container metrics)
  4317  — Jaeger OTLP (gRPC)
  16686 — Jaeger UI
  9090  — Prometheus
  3001  — Grafana
```

All .NET services run **locally** (not in Docker). Infrastructure (Postgres, RabbitMQ,
Temporal, monitoring) runs in Docker.

---

## 3. Starting Infrastructure (Docker)

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison

# Start all infrastructure containers
docker compose up -d

# Verify all containers are running
docker compose ps
```

Wait ~15-20 seconds for Temporal auto-setup to complete (it creates schemas in Postgres).

**Verify health:**

```bash
# PostgreSQL
docker exec saga-postgres pg_isready -U saga -d sagadb

# RabbitMQ
docker exec saga-rabbitmq rabbitmq-diagnostics -q ping

# Temporal (should return namespace info with state "NAMESPACE_STATE_REGISTERED")
curl -s http://localhost:8080/api/v1/namespaces | head -c 200
```

---

## 4. Starting .NET Services

You need **6 terminal windows** (or use a terminal multiplexer). Each service must be
started from its own project directory.

### Terminal 1 — API Gateway

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/ApiGateway
dotnet run
```

### Terminal 2 — OrderService

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/OrderService
dotnet run
```

### Terminal 3 — InventoryService

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/InventoryService
dotnet run
```

### Terminal 4 — PaymentService

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/PaymentService
dotnet run
```

### Terminal 5 — ShippingService

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/ShippingService
dotnet run
```

### Terminal 6 — NotificationService

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/NotificationService
dotnet run
```

**Quick health check:**

```bash
curl http://localhost:5005/api/orders/config
# Should return: {"sagaMode":"orchestration"}
```

---

## 5. Switching Between Orchestration and Choreography

The mode is set via `SagaMode` in each service's `appsettings.json`. By default, all
services are set to `"orchestration"`.

### Switch to Choreography

Edit `SagaMode` in **all 5 service** `appsettings.json` files:

```
src/Services/OrderService/appsettings.json
src/Services/InventoryService/appsettings.json
src/Services/PaymentService/appsettings.json
src/Services/ShippingService/appsettings.json
src/Services/NotificationService/appsettings.json
```

Change:
```json
"SagaMode": "choreography"
```

Or override via environment variable (no file edits needed):

```bash
# In each terminal, prefix the run command:
SagaMode=choreography dotnet run
```

**After switching, restart all 5 .NET services.** Then verify:

```bash
curl http://localhost:5005/api/orders/config
# Should return: {"sagaMode":"choreography"}
```

### Switch Back to Orchestration

```bash
SagaMode=orchestration dotnet run
# Or revert appsettings.json to "orchestration"
```

---

## 6. Verifying Everything Works

### Quick smoke test — create one order

```bash
curl -s -X POST http://localhost:5005/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "11111111-1111-1111-1111-111111111111",
    "items": [{"productId": "a1111111-1111-1111-1111-111111111111", "quantity": 1, "unitPrice": 29.99}]
  }' | jq .
```

Expected: `{"orderId":"...","mode":"orchestration"}` (or choreography)

### Check order completed

```bash
# Replace <orderId> with the ID from above
curl -s http://localhost:5005/api/orders/0c155986-1263-4ff1-95c5-625e468fed18/status | jq .
```

Expected: `{"status":"Completed","completedAt":"..."}` (may take 1-3 seconds)

### Benchmark a single order (full saga timing)

```bash
curl -s -X POST http://localhost:5005/api/orders/benchmark \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "11111111-1111-1111-1111-111111111111",
    "items": [{"productId": "a1111111-1111-1111-1111-111111111111", "quantity": 1, "unitPrice": 29.99}]
  }' | jq .
```

This returns full timing breakdown: `apiResponseMs`, `totalSagaDurationMs`,
`compensationDurationMs`, `stepTransitions`.

---

## 7. Test A: Saga Benchmark — end-to-end + per-step (P95)

**Purpose:** Primary performance test. One k6 run yields headline saga percentiles **and** per-step bottleneck breakdown. This is the test you cite in the thesis.

**Script:** `benchmark-saga-steps.js`

**What it measures, per sample:**

- `apiResponseMs` — time from POST to saga-initiated
- `totalSagaDurationMs` — saga-initiated to terminal state
- `compensationDurationMs` — Compensating→Failed window (null on success)
- `stepDurationsMs` — per-step (reserveInventory, processPayment, arrangeShipping, sendNotification, updateStatus)

A short warmup phase (`WARMUP=5s` by default) runs before the main phase so the first requests don't skew P95.

### Run for Orchestration

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

curl -s -X POST http://localhost:5005/api/inventory/reset > /dev/null
curl -s -X DELETE http://localhost:5005/api/orders/reset > /dev/null

k6 run \
  --env MODE=orchestration \
  --env RATE=10 \
  --env DURATION=60s \
  --env WARMUP=5s \
  --env BASE_URL=http://localhost:5005 \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-saga-steps.js
```

### Run for Choreography

```bash
# Switch all services to choreography, restart them, then:
curl -s -X POST http://localhost:5005/api/inventory/reset > /dev/null
curl -s -X DELETE http://localhost:5005/api/orders/reset > /dev/null

k6 run --env MODE=choreography --env RATE=10 --env DURATION=60s \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-saga-steps.js
```

### Output

- `results/steps_<mode>_<rate>rps.json` — canonical (overwritten per rate)
- `results/steps_<mode>_<rate>rps_<timestamp>.json` — history preserved

### Recommended rates to test

| Rate | Purpose |
|------|---------|
| 1 req/s | Baseline — no contention |
| 5 req/s | Light load |
| 10 req/s | Moderate load |
| 25 req/s | Heavy load — look for degradation |
| 100 req/s | Saturation — where does each pattern break first? |

### Suggested per-step thesis table

| Step | Orchestration P95 (ms) | Choreography P95 (ms) | Δ |
|------|------------------------|------------------------|---|
| Reserve Inventory | X | Y | X-Y |
| Process Payment | X | Y | X-Y |
| Arrange Shipping | X | Y | X-Y |
| Send Notification | X | Y | X-Y |
| Update Status | X | Y | X-Y |
| **Total** | **X** | **Y** | **X-Y** |

---

## 8. Test B: Fire-and-forget Throughput

**Purpose:** Measure HTTP response time at sustained rates *without* waiting for saga completion. Tests API-gateway intake throughput independently of the saga pipeline.

**Script:** `order-load-test.js`

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# Multi-rate suite
./run-benchmarks.sh orchestration
./run-benchmarks.sh choreography

# Or run both interactively (prompts to switch modes):
./run-benchmarks.sh both
```

Rates tested: 1, 5, 10, 25, 50, 100, 250, 500, 1000 req/s (edit `RATES=(...)` in the script).

---

## 9. Test C: Full Benchmark Matrix

**Purpose:** Runs Test A (`benchmark-saga-steps.js`) at multiple rates automatically and aggregates all results into a single summary JSON.

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# For orchestration (default rates: 1, 5, 10, 25)
./run-full-benchmark.sh orchestration

# For choreography
./run-full-benchmark.sh choreography 1 5 10 25 50 100 250 500

# Custom rates
./run-full-benchmark.sh orchestration 1 5 10 25 50 100 250 500
```

**Output:** `results/benchmark_orchestration_summary.json` — array of all rate results with percentiles.

---

## 10. Test D: Resource Scaling Test (CPU/IO Bottlenecks)

**Purpose:** Prove whether performance is CPU-bound or IO-bound by running the same load test with different resource limits on Temporal/RabbitMQ.

### Profiles

| Profile | CPU | Memory | Use Case |
|---------|-----|--------|----------|
| `constrained` | 0.5 cores | 256MB | Simulate under-provisioned infra |
| `default` | 1.0 cores | 512MB | Baseline |
| `generous` | 2.0 cores | 1024MB | Well-provisioned |
| `unlimited` | No limits | No limits | Maximum available |

### Running the test

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# 1. Run orchestration with constrained Temporal
./run-resource-scaling-test.sh orchestration constrained

# 2. After that completes, run with generous Temporal
./run-resource-scaling-test.sh orchestration generous

# 3. Compare choreography
./run-resource-scaling-test.sh choreography constrained
./run-resource-scaling-test.sh choreography generous
```

**IMPORTANT:** After each `run-resource-scaling-test.sh`, you must restart the .NET
services manually (the script only restarts Docker infrastructure).

### What to look for

| Observation | Diagnosis |
|---|---|
| P95 latency drops significantly with more CPU | **CPU-bound** — the orchestrator/broker is compute-starved |
| P95 barely changes across profiles | **IO-bound** — bottleneck is network/disk, not CPU |
| CPU throttling > 0 in Grafana | Container is hitting its CPU limit |
| Memory usage = Memory limit | Container is memory-starved, may OOM |
| Temporal degrades more than RabbitMQ under constraint | Temporal is more resource-hungry |

### Output

Saved to `results/resource-scaling/`:
- `stats_pre_*` — container resource snapshot before test
- `stats_during_*` — CPU/RAM sampled every 2s during test (CSV)
- `stats_post_*` — container resource snapshot after test
- `k6_log_*` — k6 console output with percentiles
- `k6_*.json` — structured results

---

## 11. Test E: Inventory-Visibility Lag

**Purpose:** Measure real eventual-consistency lag — how long after `POST /api/orders` does the reserved stock become readable via `GET /api/inventory/products`?

**Script:** `benchmark-consistency-lag.js`

Replaces the earlier test (which polled `Order.Status` for intermediate states that are never written to the DB and returned meaningless data). This version:

1. Snapshots `reservedQuantity` for the target product
2. Posts an order
3. Polls the inventory endpoint every 25 ms until `reservedQuantity` increases
4. Also records `saga_completion_lag_ms` (POST → Order.Status = Completed)

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# Orchestration
k6 run --env MODE=orchestration --env ITERATIONS=30 \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-consistency-lag.js

# Choreography (switch services first)
k6 run --env MODE=choreography --env ITERATIONS=30 \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-consistency-lag.js
```

**What to look for:** the delta between `inventory_visibility_lag_ms` and `saga_completion_lag_ms` tells you how far "ahead" the inventory write lands relative to the final Order update. Choreography typically shows lower lag because stock is written directly by the InventoryService consumer.

---

## 12. Test F: Race Condition / Concurrency

**Purpose:** 20 concurrent users try to buy the single-stock "Limited Edition Tablet". Exactly 1 must win. Validates optimistic concurrency on `Product.Version`.

**Script:** `benchmark-race-condition.js`

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# Orchestration
k6 run --env MODE=orchestration --env VUS=20 benchmark-race-condition.js

# Choreography
k6 run --env MODE=choreography --env VUS=20 benchmark-race-condition.js
```

The script prints a `PASS/FAIL` correctness verdict. `FAIL (N winners — oversell!)` with N > 1 means the concurrency control broke.

---

## 13. Test G: Idempotency

**Purpose:** Verify that the same `IdempotencyKey` on `POST /api/orders` returns the **same** `OrderId` on both requests — no duplicate saga, no double charge.

**Script:** `benchmark-idempotency.js`

The test asserts three checks per iteration:

1. Both POSTs return HTTP 202
2. Both responses carry the same `orderId`
3. The second response includes `Idempotent: true`

A hard k6 threshold (`duplicate_orders_created: count==0`) fails the test run on any regression.

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# Orchestration
k6 run --env MODE=orchestration --env ITERATIONS=20 benchmark-idempotency.js

# Choreography
k6 run --env MODE=choreography --env ITERATIONS=20 benchmark-idempotency.js
```

---

## 14. Test H: Compensation / Failure Benchmark (100% forced fail)

**Purpose:** Measure the Compensating→Failed window when every saga is forced to roll back. This isolates the raw compensation cost with matched retry configs.

### Set 100% payment failure

```bash
curl -s -X POST http://localhost:5005/api/payments/failure-rate/100
curl -s http://localhost:5005/api/payments/failure-rate  # verify
```

### Run

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# Orchestration — every saga compensates
k6 run --env MODE=orchestration_compensation --env RATE=5 --env DURATION=30s \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-saga-steps.js

# Choreography — switch services, then:
k6 run --env MODE=choreography_compensation --env RATE=5 --env DURATION=30s \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-saga-steps.js
```

### Reset failure rate after testing

```bash
curl -s -X POST http://localhost:5005/api/payments/failure-rate/0
```

Look at `compensationDurationMs` in the results — this is the Compensating→Failed window captured by polling `Order.Status`.

---

## 15. Test I: Mixed Workload (realistic 10% fail)

**Purpose:** Run with a realistic 10% failure rate so happy-path and compensation-path percentiles are captured in the **same** run. More representative than pure 0%/100%.

**Script:** `benchmark-mixed-workload.js` — automatically sets `failure-rate/10` in `setup()` and resets to 0 in `teardown()`.

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# Orchestration
k6 run --env MODE=orchestration --env RATE=10 --env DURATION=60s \
  --env FAIL_RATE_PCT=10 \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-mixed-workload.js

# Choreography
k6 run --env MODE=choreography --env RATE=10 --env DURATION=60s \
  --env FAIL_RATE_PCT=10 \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-mixed-workload.js
```

Report both `happyPathMs` and `compensationMs` percentiles side by side. Shows how the observed fail rate compares to the target (confirms the percentage is actually being hit).

---

## 16. Test J: Endurance / Sustained Load

**Purpose:** Run at a fixed rate for 5+ minutes and look for P95 drift across the start/middle/end buckets. Surfaces queue backlog growth, Temporal history-table bloat, connection-pool exhaustion, and memory leaks that single-shot benchmarks miss.

**Script:** `benchmark-endurance.js`

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# Orchestration
k6 run --env MODE=orchestration --env RATE=25 --env DURATION=5m \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-endurance.js

# Choreography
k6 run --env MODE=choreography --env RATE=25 --env DURATION=5m \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-endurance.js
```

The script prints a `P95 drift (end − start)` number. < 500 ms drift → steady-state. Larger means degradation; open Grafana and check RabbitMQ queue depth / Temporal task-queue depth / service memory.

---

## 17. Test K: Concurrent-Customer Throughput

**Purpose:** Many VUs firing simultaneously with **disjoint products**, so there is no row-level contention. Isolates pure pipeline parallelism from the concurrency-control overhead that Test F (race condition) intentionally stresses.

**Script:** `benchmark-concurrent-customers.js`

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# Orchestration
k6 run --env MODE=orchestration --env VUS=50 --env DURATION=30s \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-concurrent-customers.js

# Choreography
k6 run --env MODE=choreography --env VUS=50 --env DURATION=30s \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-concurrent-customers.js
```

Compare `effectiveThroughputPerSec` between modes, and against Test F (race condition) at the same VU count — the gap quantifies the cost of row-level contention in each pattern.

---

## 18. Test L: Cold-Start Penalty

**Purpose:** Measure the latency penalty on the first N requests after a fresh service restart. Captures Temporal worker activation, MassTransit queue binding, EF Core query-plan compilation, and .NET tiered JIT costs.

**Script:** `benchmark-cold-start.js`

> **Critical:** you must stop + start the .NET services yourself before running. The script only measures; it doesn't restart anything.

```bash
# 1. Stop all 6 .NET services (Ctrl+C in each terminal)
# 2. Restart them in the same order as section 4.
# 3. Wait ~5 seconds for listeners to open, then:

cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests
k6 run --env MODE=orchestration --env ITERATIONS=20 --env GAP_MS=500 \
  benchmark-cold-start.js

# Restart services again, switch to choreography, then:
k6 run --env MODE=choreography --env ITERATIONS=20 --env GAP_MS=500 \
  benchmark-cold-start.js
```

The report prints per-request durations, warm-tail average, and an absolute `coldPenaltyMs`.

---

## 19. Monitoring Dashboards

During any test, these dashboards are available:

| Dashboard | URL | Purpose |
|---|---|---|
| **Grafana** | http://localhost:3001 | Resource monitoring dashboard (login: admin/admin) |
| **Temporal UI** | http://localhost:8080 | Workflow executions, history, search |
| **RabbitMQ** | http://localhost:15672 | Queue depths, message rates (login: saga/saga_dev) |
| **Jaeger** | http://localhost:16686 | Distributed traces |
| **Prometheus** | http://localhost:9090 | Raw metrics queries |
| **cAdvisor** | http://localhost:8081 | Real-time container stats |

### Grafana: Resource Monitoring

1. Open http://localhost:3001 (admin / admin)
2. Go to Dashboards → Saga Comparison → **Resource Monitoring**
3. Panels: CPU Usage, Memory Usage, Network I/O, Disk I/O, CPU Throttling, Memory Limit vs Usage
4. Set time range to "Last 15 minutes" during tests

### Useful Prometheus queries

```promql
# Temporal CPU usage (%)
rate(container_cpu_usage_seconds_total{name="saga-temporal"}[30s]) * 100

# RabbitMQ memory (MB)
container_memory_usage_bytes{name="saga-rabbitmq"} / 1024 / 1024

# CPU throttling (proves resource starvation)
rate(container_cpu_cfs_throttled_seconds_total{name="saga-temporal"}[30s])
```

---

## 20. Collecting Results for Thesis

All test results are saved to `tests/LoadTests/results/`. Each script writes
**two** files: a canonical name (overwritten per run) and a timestamped copy
(so history is preserved).

```
results/
├── steps_orchestration_1rps.json                           # Test A/C canonical
├── steps_orchestration_1rps_2026-04-24T....json            # Test A timestamped
├── steps_choreography_1rps.json
├── benchmark_orchestration_summary.json                    # Test C aggregate
├── benchmark_choreography_summary.json
├── result_orchestration_10rps.json                         # Test B
├── result_choreography_10rps.json
├── consistency_orchestration.json                          # Test E (inventory-visibility lag)
├── consistency_choreography.json
├── race_orchestration_20vus.json                           # Test F
├── race_choreography_20vus.json
├── idempotency_orchestration.json                          # Test G
├── idempotency_choreography.json
├── steps_orchestration_compensation_5rps.json              # Test H (forced fail)
├── mixed_orchestration_10rps.json                          # Test I
├── mixed_choreography_10rps.json
├── endurance_orchestration_25rps.json                      # Test J
├── endurance_choreography_25rps.json
├── concurrent_orchestration_50vus.json                     # Test K
├── concurrent_choreography_50vus.json
├── coldstart_orchestration.json                            # Test L
├── coldstart_choreography.json
└── resource-scaling/                                       # Test D
    ├── k6_orchestration_constrained_*.json
    ├── stats_during_orchestration_constrained_*.csv
    └── ...
```

### Key metrics to extract for thesis tables

From each JSON result file, the important fields are:

```json
{
  "totalSagaDurationMs":    { "p50": "...", "p95": "...", "p99": "..." },
  "compensationDurationMs": { "p95": "..." },
  "stepDurationsMs": {
    "reserveInventory": { "p95": "..." },
    "processPayment":   { "p95": "..." },
    "arrangeShipping":  { "p95": "..." },
    "sendNotification": { "p95": "..." },
    "updateStatus":     { "p95": "..." }
  }
}
```

### Suggested thesis table format

| Metric | Orchestration (Temporal) | Choreography (MassTransit) |
|--------|--------------------------|---------------------------|
| Saga Duration P50 | X ms | Y ms |
| Saga Duration P95 | X ms | Y ms |
| Saga Duration P99 | X ms | Y ms |
| Compensation P95 (100% fail) | X ms | Y ms |
| Compensation P95 (10% fail, mixed) | X ms | Y ms |
| Inventory-Visibility Lag P95 | X ms | Y ms |
| Cold-Start Penalty | X ms | Y ms |
| Endurance P95 drift (5 min) | X ms | Y ms |
| Race Condition Correctness | 1/20 won | 1/20 won |
| Idempotency Correctness | 0 duplicates | 0 duplicates |

---

## 21. Cleanup

```bash
# Stop all Docker containers
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison
docker compose down

# Also remove volumes (resets all data)
docker compose down -v

# Stop .NET services: Ctrl+C in each terminal
```

---

## Quick Reference: Complete Test Run Checklist

For a full thesis-quality comparison, run these in order:

```
 1. docker compose up -d
 2. Start all 6 .NET services (SagaMode=orchestration)
 3. Smoke test: curl POST /api/orders/benchmark
 4. Test A : benchmark-saga-steps at 1, 5, 10, 25 rps      ← primary data + per-step
 5. Test E : benchmark-consistency-lag (inventory lag)
 6. Test F : benchmark-race-condition (20 VUs)
 7. Test G : benchmark-idempotency (20 iterations)
 8. Test I : benchmark-mixed-workload at 10% fail-rate     ← realistic mix
 9. Test J : benchmark-endurance at 25 rps × 5 min         ← drift check
10. Test K : benchmark-concurrent-customers (50 VUs)       ← parallelism
11. Test H : set failure-rate/100, benchmark-saga-steps    ← 100% compensation
12. Reset failure-rate to 0
13. Test L : stop+restart services, benchmark-cold-start   ← cold-start penalty
14. Stop all .NET services
15. Restart all 6 .NET services (SagaMode=choreography)
16. Repeat steps 3–13 for choreography
17. Test D : resource-scaling (constrained + generous, both modes)
18. Collect results from tests/LoadTests/results/
```
