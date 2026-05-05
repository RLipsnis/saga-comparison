# How to Run the Project & Perform All Tests

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Architecture Overview](#2-architecture-overview)
3. [Starting Infrastructure (Docker)](#3-starting-infrastructure-docker)
4. [Starting .NET Services](#4-starting-net-services)
5. [Switching Between Orchestration and Choreography](#5-switching-between-orchestration-and-choreography)
6. [Verifying Everything Works](#6-verifying-everything-works)
7. [Running Tests](#7-running-tests)
8. [Test A: Saga Benchmark — end-to-end + per-step (P95)](#8-test-a-saga-benchmark--end-to-end--per-step-p95)
9. [Test B: Fire-and-forget Throughput](#9-test-b-fire-and-forget-throughput)
10. [Test C: Full Benchmark Matrix](#10-test-c-full-benchmark-matrix)
11. [Test D: Resource Scaling (CPU / IO Bottlenecks)](#11-test-d-resource-scaling-cpu--io-bottlenecks)
12. [Test E: Inventory-Visibility Lag](#12-test-e-inventory-visibility-lag)
13. [Test F: Race Condition / Concurrency](#13-test-f-race-condition--concurrency)
14. [Test G: Idempotency](#14-test-g-idempotency)
15. [Test H: Mixed Workload](#15-test-h-mixed-workload)
16. [Test I: Compensation Correctness](#16-test-i-compensation-correctness)
17. [Test J: Endurance / Sustained Load](#17-test-j-endurance--sustained-load)
18. [Test K: Concurrent-Customer Throughput](#18-test-k-concurrent-customer-throughput)
19. [Test L: Cold-Start Penalty](#19-test-l-cold-start-penalty)
20. [Monitoring Dashboards](#20-monitoring-dashboards)
21. [Collecting Results for Thesis](#21-collecting-results-for-thesis)
22. [Cleanup](#22-cleanup)

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

## 7. Running Tests

All tests are run from the `tests/LoadTests/` directory using the unified `run-test.sh` script.
Every test automatically resets the database, prepares the state, and writes results — no manual
setup required.

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests
```

### Quick start

```bash
# Run a single test (mode is auto-detected from running services):
./run-test.sh steps
./run-test.sh race
./run-test.sh compensation

# Pass options through to k6:
./run-test.sh steps --env RATE=25 --env DURATION=60s
./run-test.sh concurrent --env VUS=100

# Run all tests sequentially:
./run-test.sh all
```

### Available tests

| Name | Script | Purpose |
|------|--------|---------|
| `steps` | `benchmark-saga-steps.js` | End-to-end saga + per-step timing |
| `load` | `order-load-test.js` | Fire-and-forget API throughput |
| `consistency` | `benchmark-consistency-lag.js` | Inventory visibility lag |
| `idempotency` | `benchmark-idempotency.js` | Double-click deduplication |
| `race` | `benchmark-race-condition.js` | Concurrent orders for 1-stock product |
| `concurrent` | `benchmark-concurrent-customers.js` | Parallel throughput (no contention) |
| `endurance` | `benchmark-endurance.js` | Sustained load with P95 drift |
| `mixed` | `benchmark-mixed-workload.js` | Realistic happy + compensation mix |
| `cold-start` | `benchmark-cold-start.js` | Post-restart warm-up penalty |
| `compensation` | `benchmark-compensation-correctness.js` | Compensation correctness verification |

### What each test does automatically

Every test runs a k6 `setup()` function before VUs start that:

1. Resets inventory (restocks all products, clears reservations)
2. Deletes all orders
3. Resets payment failure rate to 0% (unless the test needs failures)
4. Waits 2 seconds for state to settle

Results are written to `tests/LoadTests/results/` with both a canonical filename (overwritten each run)
and a timestamped copy (history preserved).

---

## 8. Test A: Saga Benchmark — end-to-end + per-step (P95)

**Purpose:** Primary performance test. One k6 run yields headline saga percentiles **and** per-step bottleneck breakdown. This is the test you cite in the thesis.

**What it measures per sample:**

| Metric | Description |
|--------|-------------|
| `api_response_ms` | Time from POST to saga-initiated |
| `total_saga_duration_ms` | Saga-initiated to terminal state |
| `compensation_duration_ms` | Compensating → Failed window (null on success) |
| `step_*_ms` | Per-step (reserveInventory, processPayment, arrangeShipping, sendNotification, updateStatus) |

A warmup phase (`WARMUP=5s`) runs at 1/4 rate before the main phase so the first requests don't skew P95.

### Steps

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# 1. Run for orchestration (services must be running in orchestration mode)
./run-test.sh steps --env RATE=10 --env DURATION=60s

# 2. Switch all services to choreography mode, restart them

# 3. Run for choreography
./run-test.sh steps --env RATE=10 --env DURATION=60s
```

### Recommended rates to test

| Rate | Purpose |
|------|---------|
| 1 req/s | Baseline — no contention |
| 5 req/s | Light load |
| 10 req/s | Moderate load |
| 25 req/s | Heavy load — look for degradation |
| 100 req/s | Saturation — where does each pattern break first? |

### Output

- `results/steps_<mode>_<rate>rps.json` — canonical (overwritten per rate)
- `results/steps_<mode>_<rate>rps_<timestamp>.json` — history preserved

### Suggested per-step thesis table

| Step | Orchestration P95 (ms) | Choreography P95 (ms) | Delta |
|------|------------------------|------------------------|-------|
| Reserve Inventory | X | Y | X-Y |
| Process Payment | X | Y | X-Y |
| Arrange Shipping | X | Y | X-Y |
| Send Notification | X | Y | X-Y |
| Update Status | X | Y | X-Y |
| **Total** | **X** | **Y** | **X-Y** |

---

## 9. Test B: Fire-and-forget Throughput

**Purpose:** Measure HTTP response time at sustained rates *without* waiting for saga completion. Tests API-gateway intake throughput independently of the saga pipeline.

Unlike Test A (which holds a connection for up to 30s while polling for saga completion), this test fires and forgets — measuring pure HTTP acceptance capacity.

### Steps

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# 1. Single run
./run-test.sh load --env RATE=50 --env DURATION=30s

# 2. Multi-rate suite (runs at 1, 5, 10, 25, 50, 100, 250, 500, 1000 rps)
./run-benchmarks.sh orchestration

# 3. Switch services to choreography, then:
./run-benchmarks.sh choreography
```

### Output

- `results/result_<mode>_<rate>rps.json`

---

## 10. Test C: Full Benchmark Matrix

**Purpose:** Runs Test A (`benchmark-saga-steps.js`) at multiple rates automatically and aggregates all results into a single summary JSON.

### Steps

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# 1. Run orchestration at default rates (1, 5, 10, 25)
./run-full-benchmark.sh orchestration

# 2. Custom rates
./run-full-benchmark.sh orchestration 1 5 10 25 50 100

# 3. Switch services to choreography, then:
./run-full-benchmark.sh choreography 1 5 10 25 50 100
```

Each rate resets state automatically. 5-second cooldown between rates.

### Output

- `results/benchmark_<mode>_summary.json` — array of all rate results with percentiles

---

## 11. Test D: Resource Scaling (CPU / IO Bottlenecks)

**Purpose:** Prove whether performance is CPU-bound or IO-bound by running the same load test with different resource limits on Temporal/RabbitMQ.

### Profiles

| Profile | CPU | Memory | Use Case |
|---------|-----|--------|----------|
| `constrained` | 0.5 cores | 256MB | Simulate under-provisioned infra |
| `default` | 1.0 cores | 512MB | Baseline |
| `generous` | 2.0 cores | 1024MB | Well-provisioned |
| `unlimited` | No limits | No limits | Maximum available |

### Steps

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# 1. Run orchestration with constrained Temporal
./run-resource-scaling-test.sh orchestration constrained

# 2. Restart .NET services (the script only restarts Docker infrastructure)

# 3. Run with generous Temporal
./run-resource-scaling-test.sh orchestration generous

# 4. Restart .NET services again

# 5. Switch services to choreography mode

# 6. Repeat for choreography
./run-resource-scaling-test.sh choreography constrained
# restart .NET services
./run-resource-scaling-test.sh choreography generous
```

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

## 12. Test E: Inventory-Visibility Lag

**Purpose:** Measure real eventual-consistency lag — how long after `POST /api/orders` does the reserved stock become readable via `GET /api/inventory/products`?

This version:

1. Snapshots `reservedQuantity` for the target product
2. Posts an order
3. Polls the inventory endpoint every 25 ms until `reservedQuantity` increases
4. Also records `saga_completion_lag_ms` (POST -> Order.Status = Completed)

### Steps

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# 1. Run for orchestration
./run-test.sh consistency --env ITERATIONS=30

# 2. Switch services to choreography, then:
./run-test.sh consistency --env ITERATIONS=30
```

### What to look for

The delta between `inventory_visibility_lag_ms` and `saga_completion_lag_ms` tells you how far "ahead" the inventory write lands relative to the final Order update. Choreography typically shows lower lag because stock is written directly by the InventoryService consumer.

### Output

- `results/consistency_<mode>.json`

---

## 13. Test F: Race Condition / Concurrency

**Purpose:** 20 concurrent users try to buy the single-stock "Limited Edition Tablet". Exactly 1 must win. Validates optimistic concurrency on `Product.Version`.

### Steps

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# 1. Run for orchestration
./run-test.sh race --env VUS=20

# 2. Switch services to choreography, then:
./run-test.sh race --env VUS=20
```

The script prints a `PASS/FAIL` correctness verdict. `FAIL (N winners — oversell!)` with N > 1 means the concurrency control broke.

### Output

- `results/race_<mode>_<vus>vus.json`

---

## 14. Test G: Idempotency

**Purpose:** Verify that the same `IdempotencyKey` on `POST /api/orders` returns the **same** `OrderId` on both requests — no duplicate saga, no double charge.

The test asserts three checks per iteration:

1. Both POSTs return HTTP 202
2. Both responses carry the same `orderId`
3. The second response includes `Idempotent: true`

A hard k6 threshold (`duplicate_orders_created: count==0`) fails the test run on any regression.

### Steps

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# 1. Run for orchestration
./run-test.sh idempotency --env ITERATIONS=20

# 2. Switch services to choreography, then:
./run-test.sh idempotency --env ITERATIONS=20
```

### Output

- `results/idempotency_<mode>.json`

---

## 15. Test H: Mixed Workload

**Purpose:** Run with a configurable failure rate so happy-path and compensation-path percentiles are captured in the **same** run. The setup automatically configures the payment failure rate and the teardown resets it to 0.

### Steps

#### Realistic 10% failure rate

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# 1. Run for orchestration
./run-test.sh mixed --env RATE=10 --env DURATION=60s --env FAIL_RATE_PCT=10

# 2. Switch services to choreography, then:
./run-test.sh mixed --env RATE=10 --env DURATION=60s --env FAIL_RATE_PCT=10
```

#### 100% forced failure (pure compensation timing)

To isolate the raw compensation cost, set `FAIL_RATE_PCT=100`. Every saga is forced to compensate.

```bash
# 1. Run for orchestration
./run-test.sh mixed --env RATE=5 --env DURATION=30s --env FAIL_RATE_PCT=100

# 2. Switch services to choreography, then:
./run-test.sh mixed --env RATE=5 --env DURATION=30s --env FAIL_RATE_PCT=100
```

### What to look for

- `happyPathMs` vs `compensationSagaMs` — total saga time for each path
- `compensationWindowMs` — the Compensating -> Failed window
- `observedFailRatePercent` — confirms the target rate is actually being hit

### Output

- `results/mixed_<mode>_<rate>rps.json`

---

## 16. Test I: Compensation Correctness

**Purpose:** Verify that compensation actually restores system state. Sets payment failure rate to 100%, places orders, and checks:

1. **All orders reach "Failed"** — none stuck in Pending or Compensating
2. **All inventory reservations are released** — reserved quantity returns to baseline
3. **No dangling state** — all orders have a terminal status

This is a correctness test, not a performance test. It answers: "Do both patterns properly clean up after themselves when things go wrong?"

### Steps

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# 1. Run for orchestration
./run-test.sh compensation --env ITERATIONS=10

# 2. Switch services to choreography, then:
./run-test.sh compensation --env ITERATIONS=10
```

### What to look for

- `orders_stuck: count==0` in the threshold — test hard-fails if any order doesn't reach Failed
- Teardown logs report PASS/FAIL for inventory and order state assertions
- `compensation_total_ms` — time from order creation to Failed (for comparison between patterns)

### Output

- `results/compensation_<mode>.json`

---

## 17. Test J: Endurance / Sustained Load

**Purpose:** Run at a fixed rate for 5+ minutes and look for P95 drift across the start/middle/end buckets. Surfaces queue backlog growth, Temporal history-table bloat, connection-pool exhaustion, and memory leaks that single-shot benchmarks miss.

### Steps

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# 1. Run for orchestration
./run-test.sh endurance --env RATE=25 --env DURATION=5m

# 2. Switch services to choreography, then:
./run-test.sh endurance --env RATE=25 --env DURATION=5m
```

### What to look for

The script prints a `P95 drift (end - start)` number:
- < 500 ms drift -> steady-state
- Larger drift -> degradation; open Grafana and check RabbitMQ queue depth / Temporal task-queue depth / service memory

### Output

- `results/endurance_<mode>_<rate>rps.json`

---

## 18. Test K: Concurrent-Customer Throughput

**Purpose:** Many VUs firing simultaneously with **disjoint products**, so there is no row-level contention. Isolates pure pipeline parallelism from the concurrency-control overhead that Test F (race condition) intentionally stresses.

### Steps

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# 1. Run for orchestration
./run-test.sh concurrent --env VUS=50 --env DURATION=30s

# 2. Switch services to choreography, then:
./run-test.sh concurrent --env VUS=50 --env DURATION=30s
```

### What to look for

Compare `effectiveThroughputPerSec` between modes, and against Test F (race condition) at the same VU count — the gap quantifies the cost of row-level contention in each pattern.

### Output

- `results/concurrent_<mode>_<vus>vus.json`

---

## 19. Test L: Cold-Start Penalty

**Purpose:** Measure the latency penalty on the first N requests after a fresh service restart. Captures Temporal worker activation, MassTransit queue binding, EF Core query-plan compilation, and .NET tiered JIT costs.

> **Critical:** You must stop and restart the .NET services yourself before running. The script only measures; it doesn't restart anything.

### Steps

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# 1. Stop all 6 .NET services (Ctrl+C in each terminal)
# 2. Restart them in the same order as section 4
# 3. Wait ~5 seconds for listeners to open
# 4. Run for orchestration:
./run-test.sh cold-start --env ITERATIONS=20 --env GAP_MS=500

# 5. Stop all .NET services again
# 6. Switch to choreography mode and restart
# 7. Wait ~5 seconds, then:
./run-test.sh cold-start --env ITERATIONS=20 --env GAP_MS=500
```

### What to look for

The report prints per-request durations, warm-tail average, and an absolute `coldPenaltyMs`.

### Output

- `results/coldstart_<mode>.json`

---

## 20. Monitoring Dashboards

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
2. Go to Dashboards -> Saga Comparison -> **Resource Monitoring**
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

## 21. Collecting Results for Thesis

All test results are saved to `tests/LoadTests/results/`. Each script writes
**two** files: a canonical name (overwritten per run) and a timestamped copy
(so history is preserved).

```
results/
├── steps_orchestration_10rps.json                          # Test A canonical
├── steps_orchestration_10rps_2026-04-25T....json           # Test A timestamped
├── steps_choreography_10rps.json
├── benchmark_orchestration_summary.json                    # Test C aggregate
├── benchmark_choreography_summary.json
├── result_orchestration_50rps.json                         # Test B
├── result_choreography_50rps.json
├── consistency_orchestration.json                          # Test E
├── consistency_choreography.json
├── race_orchestration_20vus.json                           # Test F
├── race_choreography_20vus.json
├── idempotency_orchestration.json                          # Test G
├── idempotency_choreography.json
├── mixed_orchestration_10rps.json                          # Test H
├── mixed_choreography_10rps.json
├── compensation_orchestration.json                         # Test I
├── compensation_choreography.json
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
| Compensation Correctness | PASS | PASS |
| Inventory-Visibility Lag P95 | X ms | Y ms |
| Cold-Start Penalty | X ms | Y ms |
| Endurance P95 drift (5 min) | X ms | Y ms |
| Race Condition Correctness | 1/20 won | 1/20 won |
| Idempotency Correctness | 0 duplicates | 0 duplicates |

---

## 22. Cleanup

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

```bash
# ── Setup ───────────────────────────────────────────────────────
docker compose up -d                          # start infrastructure
# Start all 6 .NET services (SagaMode=orchestration)
# Smoke test:
curl -s -X POST http://localhost:5005/api/orders/benchmark \
  -H "Content-Type: application/json" \
  -d '{"customerId":"11111111-1111-1111-1111-111111111111","items":[{"productId":"a1111111-1111-1111-1111-111111111111","quantity":1,"unitPrice":29.99}]}' | jq .

# ── Orchestration tests ────────────────────────────────────────
cd tests/LoadTests

./run-test.sh steps        --env RATE=1 --env DURATION=30s       # Test A: baseline
./run-test.sh steps        --env RATE=10 --env DURATION=60s      # Test A: moderate
./run-test.sh steps        --env RATE=25 --env DURATION=60s      # Test A: heavy
./run-test.sh load         --env RATE=50 --env DURATION=30s      # Test B: throughput
./run-test.sh consistency  --env ITERATIONS=30                    # Test E: visibility lag
./run-test.sh race         --env VUS=20                           # Test F: concurrency
./run-test.sh idempotency  --env ITERATIONS=20                    # Test G: deduplication
./run-test.sh mixed        --env RATE=10 --env FAIL_RATE_PCT=10   # Test H: 10% fail
./run-test.sh mixed        --env RATE=5  --env FAIL_RATE_PCT=100  # Test H: 100% fail
./run-test.sh compensation --env ITERATIONS=10                    # Test I: correctness
./run-test.sh endurance    --env RATE=25 --env DURATION=5m        # Test J: drift
./run-test.sh concurrent   --env VUS=50 --env DURATION=30s        # Test K: parallelism

# Stop + restart all .NET services, then:
./run-test.sh cold-start   --env ITERATIONS=20                    # Test L: warm-up

# ── Switch to choreography ─────────────────────────────────────
# Stop all .NET services
# Change SagaMode to "choreography" (appsettings.json or env var)
# Restart all 6 .NET services

# ── Choreography tests (same commands) ─────────────────────────
./run-test.sh steps        --env RATE=1 --env DURATION=30s
./run-test.sh steps        --env RATE=10 --env DURATION=60s
./run-test.sh steps        --env RATE=25 --env DURATION=60s
./run-test.sh load         --env RATE=50 --env DURATION=30s
./run-test.sh consistency  --env ITERATIONS=30
./run-test.sh race         --env VUS=20
./run-test.sh idempotency  --env ITERATIONS=20
./run-test.sh mixed        --env RATE=10 --env FAIL_RATE_PCT=10
./run-test.sh mixed        --env RATE=5  --env FAIL_RATE_PCT=100
./run-test.sh compensation --env ITERATIONS=10
./run-test.sh endurance    --env RATE=25 --env DURATION=5m
./run-test.sh concurrent   --env VUS=50 --env DURATION=30s

# Stop + restart all .NET services, then:
./run-test.sh cold-start   --env ITERATIONS=20

# ── Resource scaling (optional) ────────────────────────────────
./run-resource-scaling-test.sh orchestration constrained
./run-resource-scaling-test.sh orchestration generous
./run-resource-scaling-test.sh choreography constrained
./run-resource-scaling-test.sh choreography generous

# ── Collect results ────────────────────────────────────────────
ls tests/LoadTests/results/
```
