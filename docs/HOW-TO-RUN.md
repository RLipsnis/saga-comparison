# How to Run the Project & Perform All Tests

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Architecture Overview](#2-architecture-overview)
3. [Starting Infrastructure (Docker)](#3-starting-infrastructure-docker)
4. [Starting .NET Services](#4-starting-net-services)
5. [Switching Between Orchestration and Choreography](#5-switching-between-orchestration-and-choreography)
6. [Verifying Everything Works](#6-verifying-everything-works)
7. [Test A: Saga Step Benchmark (P95 Percentiles)](#7-test-a-saga-step-benchmark-p95-percentiles)
8. [Test B: Load Test at Increasing Rates](#8-test-b-load-test-at-increasing-rates)
9. [Test C: Full Benchmark Matrix](#9-test-c-full-benchmark-matrix)
10. [Test D: Resource Scaling Test (CPU/IO Bottlenecks)](#10-test-d-resource-scaling-test-cpuio-bottlenecks)
11. [Test E: Per-Step Duration Benchmark (Bottleneck Analysis)](#11-test-e-per-step-duration-benchmark-bottleneck-analysis)
12. [Test F: Consistency Lag Measurement](#12-test-f-consistency-lag-measurement)
13. [Test G: Race Condition / Concurrency Test](#13-test-g-race-condition--concurrency-test)
14. [Test H: Idempotency Test](#14-test-h-idempotency-test)
15. [Test I: Compensation / Failure Benchmark](#15-test-i-compensation--failure-benchmark)
16. [Monitoring Dashboards](#16-monitoring-dashboards)
17. [Collecting Results for Thesis](#17-collecting-results-for-thesis)
18. [Cleanup](#18-cleanup)

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

## 7. Test A: Saga Step Benchmark (P95 Percentiles)

**Purpose:** Measure end-to-end saga duration with full percentile breakdown (P50/P90/P95/P99). This is the primary test for your thesis performance comparison.

**What it measures:** For each request, creates an order, polls until completion, and returns step-level timings. k6 aggregates all samples into percentile metrics.

### Run for Orchestration

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# Ensure services are running with SagaMode=orchestration
# Reset state first
curl -s -X POST http://localhost:5005/api/inventory/reset > /dev/null
curl -s -X DELETE http://localhost:5005/api/orders/reset > /dev/null

k6 run \
  --env MODE=orchestration \
  --env RATE=100 \
  --env DURATION=60s \
  --env BASE_URL=http://localhost:5005 \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-saga-steps.js
```

### Run for Choreography

```bash
# Switch all services to choreography, restart them, then:
curl -s -X POST http://localhost:5005/api/inventory/reset > /dev/null
curl -s -X DELETE http://localhost:5005/api/orders/reset > /dev/null

k6 run \
  --env MODE=choreography \
  --env RATE=100 \
  --env DURATION=60s \
  --env BASE_URL=http://localhost:5005 \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-saga-steps.js
```

### Output

Console shows formatted percentile table. JSON results saved to:
- `results/steps_orchestration_5rps.json`
- `results/steps_choreography_5rps.json`

### Recommended rates to test

| Rate | Purpose |
|------|---------|
| 1 req/s | Baseline — no contention |
| 5 req/s | Light load |
| 10 req/s | Moderate load |
| 25 req/s | Heavy load — look for degradation |

---

## 8. Test B: Load Test at Increasing Rates

**Purpose:** Fire-and-forget order creation at sustained rates. Measures HTTP response time (not saga completion). Good for testing API gateway throughput.

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# Run the full suite at multiple rates
./run-benchmarks.sh orchestration

# Then switch services to choreography and run:
./run-benchmarks.sh choreography

# Or run both (interactive — prompts you to switch modes):
./run-benchmarks.sh both
```

Rates tested: 1, 5, 10, 25, 100, 500, 1000, 5000 req/s (configurable in script).

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

## 11. Test E: Per-Step Duration Benchmark (Bottleneck Analysis)

**Purpose:** Measure how long **each individual saga step** takes (inventory reservation,
payment processing, shipping arrangement, notification, DB status update). This is the key
test for identifying which step is the bottleneck and where orchestration overhead appears
compared to choreography.

**What it measures:**
- **Orchestration:** Uses `Workflow.UtcNow` inside the Temporal workflow to time each activity
  (includes Temporal scheduling + HTTP call + downstream service processing).
- **Choreography:** Records `DateTime.UtcNow` timestamps in the saga state on each event
  completion (measures message broker hop + consumer processing).

### Run for Orchestration

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

curl -s -X POST http://localhost:5005/api/inventory/reset > /dev/null
curl -s -X DELETE http://localhost:5005/api/orders/reset > /dev/null

k6 run \
  --env MODE=orchestration \
  --env RATE=5 \
  --env DURATION=30s \
  --env BASE_URL=http://localhost:5005 \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-step-durations.js
```

### Run for Choreography

```bash
curl -s -X POST http://localhost:5005/api/inventory/reset > /dev/null
curl -s -X DELETE http://localhost:5005/api/orders/reset > /dev/null

k6 run \
  --env MODE=choreography \
  --env RATE=5 \
  --env DURATION=30s \
  --env BASE_URL=http://localhost:5005 \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-step-durations.js
```

### What to look for

| Observation | Meaning |
|---|---|
| Orchestration step X > Choreography step X | Temporal scheduling overhead for that activity |
| `processPayment` similar in both | Simulated gateway delay dominates, not coordination |
| Orchestration has extra `updateStatus` step | DB write that choreography handles via events |
| One step P95 >> all others | That step is the bottleneck |

### Output

Console shows per-step percentile table. JSON saved to:
- `results/step_durations_orchestration_5rps.json`
- `results/step_durations_choreography_5rps.json`

### Suggested thesis table format

| Step | Orchestration P95 (ms) | Choreography P95 (ms) | Delta |
|------|------------------------|------------------------|-------|
| Reserve Inventory | X | Y | X-Y |
| Process Payment | X | Y | X-Y |
| Arrange Shipping | X | Y | X-Y |
| Send Notification | X | Y | X-Y |
| Update Status | X | N/A | — |
| **Total** | **X** | **Y** | **X-Y** |

---

## 12. Test F: Consistency Lag Measurement

**Purpose:** Measure **eventual consistency lag** — how long after placing an order does the inventory actually decrease?

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# Reset inventory first
curl -s -X POST http://localhost:5005/api/inventory/reset > /dev/null
curl -s -X DELETE http://localhost:5005/api/orders/reset > /dev/null

# Orchestration
k6 run --env MODE=orchestration --env ITERATIONS=20 \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-consistency-lag.js

# Choreography (switch services first)
k6 run --env MODE=choreography --env ITERATIONS=50 \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-consistency-lag.js
```

**Expected insight:** Choreography may show slightly lower consistency lag since
services react to events immediately. Orchestration routes through the Temporal server.

---

## 13. Test G: Race Condition / Concurrency Test

**Purpose:** 20 concurrent users try to buy a product with only 1 unit in stock. Exactly 1 should succeed. Tests data consistency under contention.

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# Orchestration
k6 run --env MODE=orchestration --env VUS=20 \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-race-condition.js

# Choreography (switch services first)
k6 run --env MODE=choreography --env VUS=20 \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-race-condition.js
```

**Expected output:** `race_wins = 1`, `race_losses = 19`. If `race_wins > 1`, there's
an over-sell bug (data consistency failure).

---

## 14. Test H: Idempotency Test

**Purpose:** Send the same order twice (simulating double-click). Verifies whether
duplicate orders are created or properly deduplicated.

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# Orchestration
k6 run --env MODE=orchestration --env ITERATIONS=20 \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-idempotency.js

# Choreography
k6 run --env MODE=choreography --env ITERATIONS=20 \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-idempotency.js
```

**What to look for:** `duplicate_orders_created` should be 0 if idempotency works.

---

## 15. Test I: Compensation / Failure Benchmark

**Purpose:** Measure how long compensation (rollback) takes when a saga step fails.
This directly tests the "apples-to-apples" retry configuration from Point 4.

### Set up a failure trigger

The PaymentService has a configurable failure rate:

```bash
# Set 100% payment failure (forces every saga to compensate)
curl -s -X POST http://localhost:5005/api/payments/failure-rate/100

# Verify
curl -s http://localhost:5005/api/payments/failure-rate
```

### Run the test

```bash
cd /Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests

# Orchestration — all orders will fail at payment step and trigger compensation
k6 run \
  --env MODE=orchestration_compensation \
  --env RATE=5 \
  --env DURATION=30s \
  --env BASE_URL=http://localhost:5005 \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-saga-steps.js

# Choreography — switch services, then same test
k6 run \
  --env MODE=choreography_compensation \
  --env RATE=5 \
  --env DURATION=30s \
  --env BASE_URL=http://localhost:5005 \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
  benchmark-saga-steps.js
```

### Reset failure rate after testing

```bash
curl -s -X POST http://localhost:5005/api/payments/failure-rate/5
```

**Expected insight:** With matched retry configs (Point 4 changes), Temporal and
MassTransit compensation times should now be comparable. The output includes separate
`compensationDurationMs` percentiles.

---

## 16. Monitoring Dashboards

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

## 17. Collecting Results for Thesis

All test results are saved to `tests/LoadTests/results/`. Here's what you'll have
after running all tests:

```
results/
├── steps_orchestration_1rps.json         # Test A/C per-rate
├── steps_orchestration_5rps.json
├── steps_orchestration_10rps.json
├── steps_choreography_1rps.json
├── steps_choreography_5rps.json
├── steps_choreography_10rps.json
├── benchmark_orchestration_summary.json  # Test C aggregated
├── benchmark_choreography_summary.json
├── result_orchestration_10rps.json       # Test B per-rate
├── result_choreography_10rps.json
├── consistency_orchestration.json        # Test E
├── consistency_choreography.json
├── race_orchestration_20vus.json         # Test F
├── race_choreography_20vus.json
├── idempotency_orchestration.json        # Test G
├── idempotency_choreography.json
├── step_durations_orchestration_5rps.json # Test E per-step
├── step_durations_choreography_5rps.json
├── resource-scaling/                     # Test D
│   ├── k6_orchestration_constrained_*.json
│   ├── k6_orchestration_generous_*.json
│   ├── stats_during_orchestration_constrained_*.csv
│   └── ...
└── steps_orchestration_compensation_5rps.json  # Test I
```

### Key metrics to extract for thesis tables

From each JSON result file, the important fields are:

```json
{
  "totalSagaDurationMs": {
    "avg": "...",
    "p95": "...",    // <-- primary comparison metric
    "p99": "..."
  },
  "compensationDurationMs": {
    "avg": "...",
    "p95": "..."
  }
}
```

### Suggested thesis table format

| Metric | Orchestration (Temporal) | Choreography (MassTransit) |
|--------|--------------------------|---------------------------|
| Saga Duration P50 | X ms | Y ms |
| Saga Duration P95 | X ms | Y ms |
| Saga Duration P99 | X ms | Y ms |
| Compensation P95 | X ms | Y ms |
| Consistency Lag P95 | X ms | Y ms |
| Race Condition Correctness | 1/20 won | 1/20 won |
| Idempotency Correctness | 0 duplicates | 0 duplicates |

---

## 18. Cleanup

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
4. Test A: benchmark-saga-steps at 1, 5, 10, 25 rps   ← primary data
5. Test E: benchmark-step-durations at 5 rps            ← bottleneck data
6. Test F: benchmark-consistency-lag (20 iterations)
7. Test G: benchmark-race-condition (20 VUs)
8. Test H: benchmark-idempotency (20 iterations)
9. Test I: Set failure-rate/100, benchmark-saga-steps   ← compensation data
10. Reset failure-rate to 5
11. Stop all .NET services
12. Restart all 6 .NET services (SagaMode=choreography)
13. Repeat steps 3–10 for choreography
14. Test D: resource-scaling (constrained + generous, both modes)
15. Collect results from tests/LoadTests/results/
```
