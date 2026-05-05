# How to Run the Project & Perform All Tests

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Architecture Overview](#2-architecture-overview)
3. [Starting the Stack](#3-starting-the-stack)
4. [Watching Logs / Operating Services](#4-watching-logs--operating-services)
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
20. [Test M: Failure During Rollback (Resilience)](#20-test-m-failure-during-rollback-resilience)
21. [Test N: Broker Outage During Rollback](#21-test-n-broker-outage-during-rollback)
22. [Test O: Worker Crash Mid-Saga](#22-test-o-worker-crash-mid-saga)
23. [Monitoring Dashboards](#23-monitoring-dashboards)
24. [Collecting Results for Thesis](#24-collecting-results-for-thesis)
25. [Cleanup](#25-cleanup)

---

## 1. Prerequisites

Install these tools before starting:

```bash
# Docker Desktop (must be running) — builds and runs everything
docker --version
docker compose version

# k6 load testing tool
brew install k6

# jq for JSON processing (used in benchmark scripts)
brew install jq

# .NET 8 SDK — OPTIONAL. Only needed if you want to develop services
# bare-metal (e.g. hot-reload). The Docker images bundle their own SDK,
# so you don't need it locally to run any of the tests.
dotnet --version   # should be 8.x  (optional)
```

---

## 2. Architecture Overview

```
Port Map:
  5005  — API Gateway (YARP reverse proxy)        ← k6 hits this
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

**Everything runs in Docker.** The 6 .NET services (5 saga services + api-gateway) are
built from a shared multi-stage Dockerfile at `infrastructure/dotnet/Dockerfile` and
orchestrated by `docker-compose.yml` alongside the saga infrastructure (Postgres,
RabbitMQ, Temporal, monitoring stack). No `dotnet run` is required to operate the
system.

Container names follow the `saga-*` convention:

```
saga-api-gateway          (5005)
saga-order-service        (5010)
saga-inventory-service    (5011)
saga-payment-service      (5012)
saga-shipping-service     (5013)
saga-notification-service (5014)
saga-postgres / saga-rabbitmq / saga-temporal / ...
```

The `SagaMode` is read from the `SAGA_MODE` env var injected by Docker Compose, so
flipping orchestration ↔ choreography is just a recreate of the .NET service
containers — no source edits.

---

## 3. Starting the Stack

One command brings up the full system — infrastructure, .NET services, monitoring:

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison

# First run: this also builds the 6 .NET service images (~3-5 min, ~700 MB SDK pull).
# Subsequent runs reuse the cached images.
docker compose up -d

# Verify everything came up healthy
docker compose ps
```

`docker compose up -d` will build images on first run, then start all containers in
the right order via `depends_on`. The api-gateway has a `depends_on` chain that gates
on every saga service being healthy, so when `docker compose ps` shows api-gateway
as `Up`, the entire system is ready.

Total cold start ≈ 30-45 seconds: Temporal needs ~15 s for auto-setup (schema creation),
then each .NET service needs ~5-10 s to start, run EF migrations, and pass its healthcheck.

**Verify health:**

```bash
# All saga services + infra
docker compose ps

# Quick smoke test through the gateway
curl -s http://localhost:5005/api/orders/config
# → {"sagaMode":"orchestration"}  (or whatever SAGA_MODE was set to)

# Per-service healthchecks
curl -s http://localhost:5010/health    # OrderService
curl -s http://localhost:5011/health    # InventoryService
curl -s http://localhost:5012/health    # PaymentService
curl -s http://localhost:5013/health    # ShippingService
curl -s http://localhost:5014/health    # NotificationService

# Infrastructure
docker exec saga-postgres pg_isready -U saga -d sagadb
docker exec saga-rabbitmq rabbitmq-diagnostics -q ping
curl -s http://localhost:8080/api/v1/namespaces | head -c 200
```

### Rebuilding after code changes

If you edit any `.cs` file, rebuild the affected service image and recreate its container:

```bash
docker compose build order-service                   # rebuild one service
docker compose up -d --force-recreate order-service  # restart it with the new image

# Or rebuild + restart everything in one go:
docker compose up -d --build --force-recreate
```

---

## 4. Watching Logs / Operating Services

### Tail logs from one or many services

```bash
# Tail one service
docker compose logs -f order-service

# Tail all .NET services in a single stream
docker compose logs -f order-service inventory-service payment-service shipping-service notification-service api-gateway

# Last 100 lines, no follow
docker compose logs --tail=100 order-service
```

### Restart, stop, start individual services

```bash
docker compose restart order-service
docker compose stop  inventory-service
docker compose start inventory-service
```

### Bare-metal development (optional)

If you want hot-reload while developing, the code still works against bare-metal
because every config knob defaults to `localhost`. Stop the Docker copy of the
service you're editing and `dotnet run` from its project directory:

```bash
docker compose stop order-service
cd src/Services/OrderService && dotnet run
```

Docker continues to host the *other* services + infrastructure on their normal
ports, so the bare-metal OrderService can talk to them via `localhost:5011…5014`.
This is **only** for dev convenience — every test in this document assumes the
standard Docker-only setup.

---

## 5. Switching Between Orchestration and Choreography

The mode is controlled by the `SAGA_MODE` env var, which Docker Compose injects into
every .NET service container as `SagaMode`. There are **no `appsettings.json` edits**
required.

### Switch to Choreography

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison

# Recreate the .NET services with the new mode. Infrastructure stays up.
SAGA_MODE=choreography docker compose up -d --force-recreate \
  order-service inventory-service payment-service shipping-service notification-service

# Verify
curl -s http://localhost:5005/api/orders/config
# → {"sagaMode":"choreography"}
```

`--force-recreate` is required because env vars only take effect at container creation
time. Without it, the existing container would keep its previous `SagaMode`. Postgres,
RabbitMQ, and Temporal are NOT touched by this command — only the .NET services are
recreated, so saga state from previous runs persists in Postgres unless you reset it.

### Switch back to Orchestration

```bash
SAGA_MODE=orchestration docker compose up -d --force-recreate \
  order-service inventory-service payment-service shipping-service notification-service
```

### Persist a default mode

If you usually run choreography (or want a different default), put it in `.env` at
the repo root so you don't have to type the prefix every time:

```bash
echo 'SAGA_MODE=choreography' >> .env
docker compose up -d --force-recreate \
  order-service inventory-service payment-service shipping-service notification-service
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

Expected: `{"orderId":"...","mode":"orchestration"}` (or choreography).

### Check the order completed

```bash
# Replace <orderId> with the ID from above
ORDER_ID=...
curl -s http://localhost:5005/api/orders/$ORDER_ID/status | jq .
```

Expected: `{"status":"Completed","completedAt":"..."}` (may take 1-3 seconds).

### Benchmark a single order (full saga timing)

This is the same endpoint k6 uses for Test A. It blocks until the saga reaches a
terminal state and returns full timing telemetry:

```bash
curl -s -X POST http://localhost:5005/api/orders/benchmark \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "11111111-1111-1111-1111-111111111111",
    "items": [{"productId": "a1111111-1111-1111-1111-111111111111", "quantity": 1, "unitPrice": 29.99}]
  }' | jq .
```

Returns `apiResponseMs`, `totalSagaDurationMs`, `compensationDurationMs`,
`stepTransitions`, and `stepDurationsMs`.

If the response hangs for 30 seconds and returns `totalSagaDurationMs: -1`, one of
the downstream services is unhealthy. Check `docker compose ps` for any service
stuck in `starting` / `unhealthy`, and `docker compose logs <service>` for errors.

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
| `rollback-failure` | `benchmark-rollback-failure.js` | Failure DURING rollback (lecturer's scenario, Test M) |

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

# 1. Run for orchestration (services already up in orchestration mode)
./run-test.sh steps --env RATE=100 --env DURATION=60s

# 2. Recreate .NET services in choreography mode (see section 5)
SAGA_MODE=choreography docker compose -f ../../docker-compose.yml up -d --force-recreate \
  order-service inventory-service payment-service shipping-service notification-service
sleep 15  # let healthchecks settle

# 3. Run for choreography
./run-test.sh steps --env RATE=100 --env DURATION=60s
```

`run-test.sh` auto-detects the current mode by hitting `/api/orders/config`, so you
never need to pass `--env MODE=...`. The mode label is taken from whatever the running
stack reports.

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

# 1. Single run (auto-detects mode)
./run-test.sh load --env RATE=50 --env DURATION=30s

# 2. Multi-rate suite for the current mode
./run-benchmarks.sh orchestration

# 3. Switch the .NET services to choreography:
SAGA_MODE=orchestration docker compose -f ../../docker-compose.yml up -d --force-recreate \
  order-service inventory-service payment-service shipping-service notification-service
sleep 15

# 4. Multi-rate suite for choreography
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
./run-full-benchmark.sh orchestration 1 5 10 25 50 100 250

# 3. Switch the .NET services to choreography mode:
SAGA_MODE=choreography docker compose -f ../../docker-compose.yml up -d --force-recreate \
  order-service inventory-service payment-service shipping-service notification-service
sleep 15

# 4. Run for choreography
./run-full-benchmark.sh choreography 1 5 10 25 50 100
```

Each rate resets state automatically. 5-second cooldown between rates.

### Output

- `results/benchmark_<mode>_summary.json` — array of all rate results with percentiles

---

## 11. Test D: Resource Scaling (CPU / IO Bottlenecks)

**Purpose:** Show whether performance is CPU-bound or IO-bound by running the same load test with different resource limits on **both** the saga infrastructure (Temporal / RabbitMQ / Postgres) **and** the .NET service processes where the actual saga work runs.

> **Important:** every container is now built and run from `docker-compose.yml` — including the .NET services. There is no manual `dotnet run` for this test. The script in `run-resource-scaling-test.sh` builds images and brings the full stack up before each profile so the limits are guaranteed to take effect.

### Profiles

Both infra and service containers scale together:

| Profile | Infra CPU/RAM | Service CPU/RAM | Use Case |
|---------|---------------|------------------|----------|
| `constrained` | 0.5 / 256M | 0.5 / 256M | Under-provisioned everything |
| `default` | 1.0 / 512M | 1.0 / 512M | Baseline |
| `generous` | 2.0 / 1024M | 2.0 / 1024M | Well-provisioned |
| `unlimited` | (no limits) | (no limits) | Maximum available |

The script also recognises `ORDER_CPUS` / `ORDER_MEMORY` and `GATEWAY_CPUS` / `GATEWAY_MEMORY` overrides if you want to throttle a single hot service independently.

### Steps

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# Higher RATE makes the limits actually bite. At 10 rps everything is idle.
RATE=10 DURATION=60s ./run-resource-scaling-test.sh orchestration constrained
RATE=25 DURATION=60s ./run-resource-scaling-test.sh orchestration generous

RATE=10 DURATION=60s ./run-resource-scaling-test.sh choreography constrained
RATE=25 DURATION=60s ./run-resource-scaling-test.sh choreography generous
```

The script handles everything: rebuilds images if source changed, brings containers up with the right `SAGA_MODE`, waits for the api-gateway to become reachable, resets state, runs k6, captures stats, and tears nothing down between profiles (so subsequent runs reuse warm images).

### What to look for

| Observation | Diagnosis |
|---|---|
| P95 latency drops significantly with more CPU | **CPU-bound** — workers / orchestrator / broker is compute-starved |
| P95 barely changes across profiles | **IO-bound** — bottleneck is network / disk, not CPU |
| `cpu_pct` in `stats_during_*.csv` ≈ limit | Container is throttled |
| Memory usage ≈ memory limit | Container is RAM-starved (may OOM) |
| Service container CPU pegged before infra is | Saga work is the bottleneck (not the orchestrator/broker) |

### Reading the results

Look at `stats_during_*.csv`, **not** the post-test snapshot. Post-test is essentially idle because k6 has stopped by the time the snapshot is taken. Sampling runs every 2s during the load.

Quick peak-CPU per container:

```bash
RUN=stats_during_orchestration_constrained_<timestamp>.csv
awk -F, '{ gsub("%","",$3); if ($3+0 > peak[$2]) peak[$2]=$3 } END { for (c in peak) printf "%-30s %s%%\n", c, peak[c] }' results/resource-scaling/$RUN
```

### Output

Saved to `results/resource-scaling/`:
- `stats_pre_*` — container resource snapshot before test (mostly idle, useful as baseline)
- `stats_during_*.csv` — CPU/RAM sampled every 2s during test (the **real** signal)
- `stats_post_*` — container resource snapshot after test (also idle)
- `k6_log_*` — k6 console output with percentiles
- `k6_*.json` — structured results

### Why this changed (April 2026)

Previously the script only constrained the infra containers. The .NET services ran outside Docker with no limits, so the test mostly measured Postgres pressure rather than saga-pattern overhead. Now every component is in Docker with its own budget, so the only variable is "how many CPUs / how much RAM does the *whole* saga (workflow + activities + consumers) get?"

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

# 2. Switch to choreography:
SAGA_MODE=orchestration docker compose -f ../../docker-compose.yml up -d --force-recreate \
  order-service inventory-service payment-service shipping-service notification-service
sleep 15

# 3. Run for choreography
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

# 2. Switch to choreography:
SAGA_MODE=choreography docker compose -f ../../docker-compose.yml up -d --force-recreate \
  order-service inventory-service payment-service shipping-service notification-service
sleep 15

# 3. Run for choreography
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

# 2. Switch to choreography:
SAGA_MODE=choreography docker compose -f ../../docker-compose.yml up -d --force-recreate \
  order-service inventory-service payment-service shipping-service notification-service
sleep 15

# 3. Run for choreography
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

# 2. Switch to choreography:
SAGA_MODE=choreography docker compose -f ../../docker-compose.yml up -d --force-recreate \
  order-service inventory-service payment-service shipping-service notification-service
sleep 15

# 3. Run for choreography
./run-test.sh mixed --env RATE=10 --env DURATION=60s --env FAIL_RATE_PCT=10
```

#### 100% forced failure (pure compensation timing)

To isolate the raw compensation cost, set `FAIL_RATE_PCT=100`. Every saga is forced to compensate.

```bash
# Orchestration
./run-test.sh mixed --env RATE=5 --env DURATION=30s --env FAIL_RATE_PCT=100

# Switch + choreography
SAGA_MODE=choreography docker compose -f ../../docker-compose.yml up -d --force-recreate \
  order-service inventory-service payment-service shipping-service notification-service
sleep 15
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

# 2. Switch to choreography:
SAGA_MODE=choreography docker compose -f ../../docker-compose.yml up -d --force-recreate \
  order-service inventory-service payment-service shipping-service notification-service
sleep 15

# 3. Run for choreography
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

# 2. Switch to choreography:
SAGA_MODE=choreography docker compose -f ../../docker-compose.yml up -d --force-recreate \
  order-service inventory-service payment-service shipping-service notification-service
sleep 15

# 3. Run for choreography
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

# 2. Switch to choreography:
SAGA_MODE=choreography docker compose -f ../../docker-compose.yml up -d --force-recreate \
  order-service inventory-service payment-service shipping-service notification-service
sleep 15

# 3. Run for choreography
./run-test.sh concurrent --env VUS=25 --env DURATION=30s
```

### What to look for

Compare `effectiveThroughputPerSec` between modes, and against Test F (race condition) at the same VU count — the gap quantifies the cost of row-level contention in each pattern.

### Output

- `results/concurrent_<mode>_<vus>vus.json`

---

## 19. Test L: Cold-Start Penalty

**Purpose:** Measure the latency penalty on the first N requests after a fresh service restart. Captures Temporal worker activation, MassTransit queue binding, EF Core query-plan compilation, and .NET tiered JIT costs.

> **Critical:** the .NET services must be freshly recreated immediately before each run, otherwise warm-up effects from the previous run will hide the cold-start cost.

### Steps

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison

# 1. Force-recreate the .NET services (this is the cold-start moment).
#    Use --force-recreate so containers are deleted and re-launched, not just
#    restarted, ensuring JIT/EF caches are cold.
SAGA_MODE=orchestration docker compose up -d --force-recreate \
  order-service inventory-service payment-service shipping-service notification-service api-gateway

# 2. Wait for healthchecks to go green
until curl -fsS http://localhost:5005/api/orders/config >/dev/null 2>&1; do sleep 1; done
sleep 2  # small buffer past the first /health pass

# 3. Run for orchestration
cd tests/LoadTests
./run-test.sh cold-start --env ITERATIONS=20 --env GAP_MS=500

# 4. Recreate fresh in choreography mode
cd ../..
SAGA_MODE=choreography docker compose up -d --force-recreate \
  order-service inventory-service payment-service shipping-service notification-service api-gateway
until curl -fsS http://localhost:5005/api/orders/config >/dev/null 2>&1; do sleep 1; done
sleep 2

# 5. Run for choreography
cd tests/LoadTests
./run-test.sh cold-start --env ITERATIONS=20 --env GAP_MS=500
```

### What to look for

The report prints per-request durations, warm-tail average, and an absolute `coldPenaltyMs`.

> **Note on what "cold" means here:** because containers are freshly recreated, JIT and
> EF caches in the service processes are cold. Postgres, RabbitMQ, and Temporal are NOT
> recreated, so their query plans / queue topology / workflow type registry stay warm.
> If you want a *fully* cold benchmark, run `docker compose down && docker compose up -d`
> instead, but expect the cold penalty to dominate by 5-10x because of Temporal
> auto-setup and Postgres warmup.

### Output

- `results/coldstart_<mode>.json`

---

## 20. Test M: Failure During Rollback (Resilience)

**Purpose:** Reproduces the *"failure during rollback"* scenario raised by the supervisor:

> *"sākas rollback. Rollback laikā: Notification service down vai Inventory service fail. Vai sistēma atkopjas vai paliek inconsistent?"*

Test I (`compensation`) only verifies the **happy compensation path** (payment fails → release succeeds → state restored). Test M instead forces a compensation step **itself** to fail and reports whether the system stays consistent.

### What it does

1. Sets `PaymentService.failure-rate=100` so every order is forced into compensation.
2. Sets the chosen compensation target's failure rate to 100 (`inventory` → `ReleaseAsync` throws; `notification` → `SendAsync` throws).
3. Places `ITERATIONS` orders. Each order's saga runs: Reserve OK → Payment FAIL → enters compensation → compensation FAILS.
4. Polls each order until terminal state OR timeout.
5. Snapshots inventory and order-status histogram.
6. Resets every failure rate so the system can be reused for other tests.

### Steps

> **First-time setup:** the failure-rate endpoints on InventoryService and NotificationService were added for this test. If you have an older image cached, `docker compose up --force-recreate` is **not enough** — Compose only recreates containers from existing images. You need to rebuild:
>
> ```bash
> cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison
> docker compose build inventory-service notification-service
> docker compose up -d --force-recreate inventory-service notification-service
> ```
>
> Verify the endpoints are reachable: `curl http://localhost:5005/api/inventory/release-failure-rate` should return `{"releaseFailureRatePercent":0}`.

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# Inventory-failure scenario (the high-impact case — leaks state)
./run-test.sh rollback-failure --env FAIL_TARGET=inventory --env ITERATIONS=10

# Notification-failure scenario (low-impact — state stays consistent, only UX is degraded)
./run-test.sh rollback-failure --env FAIL_TARGET=notification --env ITERATIONS=10

# Switch to choreography and repeat (use --build so the image picks up any new code)
cd ../..
SAGA_MODE=choreography docker compose up -d --build --force-recreate \
  order-service inventory-service payment-service shipping-service notification-service
sleep 15
cd tests/LoadTests

./run-test.sh rollback-failure --env FAIL_TARGET=inventory --env ITERATIONS=10
./run-test.sh rollback-failure --env FAIL_TARGET=notification --env ITERATIONS=10
```

### Expected divergence between patterns

| Scenario | Orchestration (Temporal) | Choreography (MassTransit) |
|---|---|---|
| `FAIL_TARGET=inventory` | `CompensationActivityOptions.MaximumAttempts = 1` → release fails once, exception swallowed in workflow's catch loop, order marked `Failed`, **inventory leaked**. | `UseMessageRetry` retries 3x, then dead-letters to `release-inventory_error`. Saga waits forever for `InventoryReleased` → **order stuck in `Compensating`** + inventory leaked. |
| `FAIL_TARGET=notification` | failure-notification is best-effort (`try { send } catch { log }`). Order reaches `Failed` cleanly, inventory released. State consistent, only customer is uninformed. | Same — saga publishes `SendNotification` fire-and-forget. State consistent. |

### What to look for

Reports printed in `handleSummary`:
- **`orders_reached_failed`** vs **`orders_stuck_compensating`** — orchestration always reaches `Failed` (sometimes misleadingly clean); choreography stalls.
- **Inventory leak** in teardown — `currentReserved - baselineReserved` shows reservations that were never released.
- **`time_to_terminal_ms`** percentiles — meaningful for orchestration, mostly absent for stuck choreography sagas.

The headline finding for the thesis: **neither pattern auto-recovers** from a permanently-failing compensation step. They differ only in *how* they fail (silent leak vs. visibly stuck). Operator action is required in both cases — see Test S (DLQ recovery cost) for a future quantification.

### Output

- `results/rollback-failure_<mode>_<target>.json` (canonical)
- `results/rollback-failure_<mode>_<target>_<timestamp>.json` (history)

---

## 21. Test N: Broker Outage During Rollback

**Purpose:** Verify that the saga survives a broker restart mid-rollback. The broker for each pattern is different:
- Orchestration → Temporal (`saga-temporal`)
- Choreography → RabbitMQ (`saga-rabbitmq`)

### What it does

1. Sets payment failure rate to 100% (every order will compensate).
2. Places `ORDERS` orders.
3. Sleeps `WARMUP_MS` so sagas are mid-flight.
4. `docker stop <broker>` for `BROKER_DOWN_SECS`.
5. `docker start <broker>` and waits for it to become reachable again.
6. Polls all orders for `RECOVERY_SECS` and reports final histogram + inventory leak.

### Steps

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# Orchestration → kills saga-temporal
./run-broker-outage-test.sh

# Switch to choreography → kills saga-rabbitmq
cd ../..
SAGA_MODE=choreography docker compose up -d --force-recreate \
  order-service inventory-service payment-service shipping-service notification-service
sleep 15
cd tests/LoadTests
./run-broker-outage-test.sh

# Tunable via env vars:
ORDERS=20 BROKER_DOWN_SECS=20 RECOVERY_SECS=120 ./run-broker-outage-test.sh
```

### Expected

- **Orchestration:** Temporal restart restores workflow history from Postgres. Worker reconnects, activities resume. Orders should reach `Failed`.
- **Choreography:** RabbitMQ restart preserves durable queues. OrderService reconnects automatically. Pending events redeliver, sagas resume.

Both should recover in this test — the more interesting comparison is **how long** recovery takes and whether either leaks. With Test M's failure injection layered on top, you can quantify combined-failure resilience.

### Output

- `results/broker-outage_<mode>.txt` (canonical)
- `results/broker-outage_<mode>_<timestamp>.txt` (history)

---

## 22. Test O: Worker Crash Mid-Saga

**Purpose:** Kill `saga-order-service` (which hosts both the Temporal worker AND the choreography saga state machine) while sagas are running, then verify they resume correctly after the container restarts.

### What it does

Same skeleton as Test N, but the target is `saga-order-service`:

1. Force payment failure 100%.
2. Place `ORDERS` orders.
3. `docker kill saga-order-service` after `WARMUP_MS`.
4. Wait `DOWN_SECS`.
5. `docker start saga-order-service` and wait for `/api/orders/config` to respond again.
6. Poll for `RECOVERY_SECS` and report final state.

### Steps

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# Orchestration
./run-worker-crash-test.sh

# Switch to choreography
cd ../..
SAGA_MODE=choreography docker compose up -d --force-recreate \
  order-service inventory-service payment-service shipping-service notification-service
sleep 15
cd tests/LoadTests
./run-worker-crash-test.sh

# Tunable via env vars:
ORDERS=20 DOWN_SECS=10 ./run-worker-crash-test.sh
```

### Expected (the comparison point)

| Aspect | Orchestration (Temporal) | Choreography (MassTransit) |
|---|---|---|
| Where state lives | Temporal server's history table (Postgres) | OrderService's saga table (Postgres) + RabbitMQ queues |
| Resume mechanism | Worker reconnects → Temporal redispatches the activity that was in flight at crash time | OrderService reconnects to RabbitMQ → drains pending events from the saga queues |
| Risk during outage | None — Temporal server is independent of OrderService | None — events accumulate in durable queues |
| Visible to operator | Workflow shows up in Temporal UI as "running" with last activity timestamp | Saga row in `OrderSagaState` table; queue depth in RabbitMQ Management UI |

Both should reach a terminal state after restart. The interesting metric is **time-to-recovery** — measured by the polling phase.

### Output

- `results/worker-crash_<mode>.txt` (canonical)
- `results/worker-crash_<mode>_<timestamp>.txt` (history)

---

## 23. Monitoring Dashboards

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

## 24. Collecting Results for Thesis

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

## 25. Cleanup

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison

# Stop everything (.NET services + infrastructure). Volumes preserved.
docker compose down

# Wipe everything including Postgres data, queues, and workflow history.
docker compose down -v

# Free disk by deleting the .NET service images too:
docker compose down --rmi local -v
```

A fresh `docker compose up -d` after `down -v` will reseed Postgres from the EF
migrations and start with the default product catalog — useful between thesis runs
to guarantee a clean baseline.

---

## Quick Reference: Complete Test Run Checklist

For a full thesis-quality comparison, run these in order. The whole suite assumes
Docker is running and the stack was started with `docker compose up -d` once at
the top.

```bash
ROOT=/Users/robertslipsnis/Desktop/Thesis/saga-comparison
DOTNET_SVCS="order-service inventory-service payment-service shipping-service notification-service"

# ── Setup ──────────────────────────────────────────
cd $ROOT
SAGA_MODE=orchestration docker compose up -d --build  # builds + starts everything

# Wait for the gateway to be reachable (gates on every service being healthy)
until curl -fsS http://localhost:5005/api/orders/config >/dev/null 2>&1; do sleep 1; done

# Smoke test:
curl -s -X POST http://localhost:5005/api/orders/benchmark \
  -H "Content-Type: application/json" \
  -d '{"customerId":"11111111-1111-1111-1111-111111111111","items":[{"productId":"a1111111-1111-1111-1111-111111111111","quantity":1,"unitPrice":29.99}]}' | jq .

# ── Orchestration tests ───────────────────────────────
cd $ROOT/tests/LoadTests

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

# Cold-start needs a fresh container recreate immediately before:
cd $ROOT && SAGA_MODE=orchestration docker compose up -d --force-recreate $DOTNET_SVCS
until curl -fsS http://localhost:5005/api/orders/config >/dev/null 2>&1; do sleep 1; done && sleep 2
cd tests/LoadTests
./run-test.sh cold-start   --env ITERATIONS=20                    # Test L: warm-up

# ── Switch to choreography ─────────────────────────────
cd $ROOT
SAGA_MODE=choreography docker compose up -d --force-recreate $DOTNET_SVCS
until curl -fsS http://localhost:5005/api/orders/config | grep -q choreography; do sleep 1; done

# ── Choreography tests (same commands) ─────────────────────
cd $ROOT/tests/LoadTests
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

# Cold-start in choreography (recreate again for a true cold sample)
cd $ROOT && SAGA_MODE=choreography docker compose up -d --force-recreate $DOTNET_SVCS
until curl -fsS http://localhost:5005/api/orders/config >/dev/null 2>&1; do sleep 1; done && sleep 2
cd tests/LoadTests
./run-test.sh cold-start   --env ITERATIONS=20

# ── Resource scaling (optional, takes care of its own up/down) ────────
RATE=100 DURATION=60s ./run-resource-scaling-test.sh orchestration constrained
RATE=100 DURATION=60s ./run-resource-scaling-test.sh orchestration generous
RATE=100 DURATION=60s ./run-resource-scaling-test.sh choreography  constrained
RATE=100 DURATION=60s ./run-resource-scaling-test.sh choreography  generous

# ── Collect results ───────────────────────────────
ls $ROOT/tests/LoadTests/results/
