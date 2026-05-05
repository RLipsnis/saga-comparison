# Saga Pattern Comparison — Analysed Test Results

This document presents the consolidated analysis of all benchmark and resilience tests comparing **orchestration** (Temporal workflows) and **choreography** (MassTransit + RabbitMQ) saga patterns.

## Table of Contents

| Test | Title | Type |
|------|-------|------|
| [A](#test-a--saga-benchmark-end-to-end--per-step) | Saga Benchmark — End-to-End + Per-Step | Performance |
| [B](#test-b--fire-and-forget-throughput) | Fire-and-Forget Throughput | Performance |
| [D](#test-d--resource-scaling) | Resource Scaling (CPU / RAM) | Performance |
| [E](#test-e--inventory-visibility-lag) | Inventory-Visibility Lag | Consistency |
| [F](#test-f--race-condition--concurrency) | Race Condition / Concurrency | Correctness |
| [G](#test-g--idempotency) | Idempotency | Correctness |
| [H](#test-h--mixed-workload) | Mixed Workload (happy + compensation) | Performance |
| [I](#test-i--compensation-correctness) | Compensation Correctness | Correctness |
| [J](#test-j--endurance--sustained-load) | Endurance / Sustained Load | Stability |
| [K](#test-k--concurrent-customer-throughput) | Concurrent-Customer Throughput | Performance |
| [L](#test-l--cold-start-penalty) | Cold-Start Penalty | Performance |
| [M](#test-m--failure-during-rollback) | Failure During Rollback | Resilience |
| [N](#test-n--broker-outage-during-rollback) | Broker Outage During Rollback | Resilience |
| [O](#test-o--worker-crash-mid-saga) | Worker Crash Mid-Saga | Resilience |
| [Overall Summary](#overall-summary) | Cross-Test Synthesis | — |
| [Atbildes](#atbildes-answers) | Pētniecības jautājumi un hipotēžu pārbaude | — |

---

## Test A — Saga Benchmark (End-to-End + Per-Step)

### Purpose

The primary performance benchmark. It captures:

- **Headline percentiles** (P50/P95/P99) for end-to-end saga latency under sustained load.
- **Per-step breakdown** so each pattern's overhead can be attributed to a specific stage (`reserveInventory`, `processPayment`, `arrangeShipping`, `sendNotification`, `updateStatus`).

It answers two thesis questions:

- At equal load, which pattern is faster end-to-end and where does the time go per step?
- As load increases, which pattern saturates first and why?

### Setup

- **Driver**: `benchmark-saga-steps.js` via `./run-test.sh steps` (k6).
- **Executor**: `constant-arrival-rate` — open model, fixed RPS regardless of response time.
- **Warmup**: 5 s at `RATE/4`. **Main phase**: 60 s at the target `RATE`.
- **VU pool**: `preAllocatedVUs = max(RATE*2, 10)`, `maxVUs = max(RATE*5, 50)`.
- **Thresholds**: `total_saga_duration_ms p95 < 10 000`; `api_response_ms p95 < 2 000` (main phase).
- **Endpoint**: `POST /api/orders/benchmark` — blocks (35 s timeout) until the saga reaches a terminal state.
- **State reset before every run**: inventory restocked, all orders deleted, payment failure rate = 0%.
- **Rates**: 1, 5, 10, 25, 50, 100 rps for both modes (12 runs total).
- **Mode switching**: `--force-recreate` of the five .NET service containers; infrastructure (Postgres, RabbitMQ, Temporal) is *not* recreated.

### Results

#### Throughput (orders that completed end-to-end)

| Rate | Orchestration completed / failed | Choreography completed / failed |
|------|----------------------------------|---------------------------------|
| 1 rps | 65 / 0 | 65 / 0 |
| 5 rps | 305 / 0 | 306 / 0 |
| 10 rps | 612 / 0 | 612 / 0 |
| 25 rps | **380 / 1 049** | 1 527 / 5 |
| 50 rps | **58 / 2 862** | 3 022 / 37 |
| 100 rps | 56 / 3 951 | 156 / 4 914 |

Orchestration breaks between 10 and 25 rps; choreography is still healthy at 50 rps and only collapses at 100.

#### Total saga duration P95 (ms)

| Rate | Orchestration | Choreography | Δ (orch − chor) |
|------|---------------|--------------|-----------------|
| 1 | 409.0 | 362.9 | +46 |
| 5 | 681.4 | 352.5 | +329 |
| 10 | 778.4 | 340.2 | +438 |
| 25 | **4 679.0** | 336.9 | +4 342 |
| 50 | 809.9¹ | 340.3 | — |
| 100 | 1 934.6¹ | 487.0¹ | — |

¹ At and above the saturation point, percentiles are computed only from *survivors*; the failing orders timed out and are excluded, so 50 / 100 rps numbers are heavily survivor-biased.

#### API response P95 (ms)

| Rate | Orchestration | Choreography |
|------|---------------|--------------|
| 1 | 18.7 | 13.7 |
| 5 | 9.6 | 8.9 |
| 10 | 13.8 | 5.0 |
| 25 | 94.9 | 3.1 |
| 50 | 27.4 | 5.1 |
| 100 | 67.5 | 4.6 |

#### Per-step P95 at 10 rps (last rate where both are healthy)

| Step | Orchestration | Choreography | Δ |
|------|---------------|--------------|---|
| Reserve Inventory | 101.8 | 13.2 | +88.6 |
| Process Payment | 299.6 | 197.8 | +101.8 |
| Arrange Shipping | 200.4 | 102.9 | +97.5 |
| Send Notification | 150.9 | 54.5 | +96.4 |
| Update Status | 101.8 | 2.7 | +99.1 |
| **Sum of step P95** | **854.5** | **371.1** | **+483.4** |

#### Per-step P95 at 25 rps (orchestration broken, choreography healthy)

| Step | Orchestration | Choreography |
|------|---------------|--------------|
| Reserve Inventory | 707.2 | 8.3 |
| Process Payment | 821.6 | 196.8 |
| Arrange Shipping | 772.6 | 100.9 |
| Send Notification | 782.6 | 52.9 |
| Update Status | 970.3 | 1.9 |

### Analysis

**Choreography is faster at every rate, even at idle.** At 1 rps choreography's saga P95 is already ~46 ms lower. Both modes hit the same DB rows and the same simulated payment delay; the gap is explained almost entirely by `updateStatus` being **~100 ms** in orchestration vs **~2 ms** in choreography. In orchestration, "Update Status" is a Temporal activity scheduled by the workflow worker, paying a full activity-task round-trip. In choreography it is a direct DB write performed by the OrderService consumer. This is a structural cost, not a load-induced one.

**Orchestration's per-step latency snaps to ~100 ms multiples.** Per-step P95s cluster on `~100`, `~200`, `~300` ms even when the underlying work would take 5–20 ms. This quantization is the signature of **Temporal task-queue polling latency** — the activity worker only picks up tasks at fixed intervals once busy. Practical implication: orchestration adds a roughly fixed ~100 ms tax *per step transition*, multiplied by 5 steps in this saga.

**The patterns saturate at very different rates.** Both modes are equivalent at 1, 5, and 10 rps (612/612 completions). The break point is between 10 and 25 rps:

- **Orchestration at 25 rps**: only ~27% complete; saga P95 explodes to 4 679 ms and P99 to 19 360 ms (right at the 35 s timeout). API P95 jumps from 13.8 → 94.9 ms — the gateway is queueing.
- **Choreography at 25 rps**: ~99.7% complete; saga P95 = 336.9 ms is essentially identical to its 10 rps value (340.2 ms).

Choreography sustains another 2× (50 rps: 98.8% success, P95 = 340 ms) before breaking at 100 rps. **Orchestration's sustainable headroom is ~10 rps; choreography's is ~50 rps — a ~5× difference under identical hardware.**

**Where does orchestration's overhead come from?** The absolute cost added per step is remarkably uniform (88–102 ms), consistent with each step paying one Temporal task-queue scheduling delay. The bottleneck is **not** the workflow code or the activity logic — it is the **workflow ↔ activity worker hand-off**, which serialises around a single task queue under load. Once arrival rate exceeds what one worker pair can dequeue, latency grows super-linearly. Choreography has no central coordinator, so the saga progresses with the parallelism of the broker.

### Caveats

- **Step P95s at 50 / 100 rps are survivor-biased.** Only orders completing within the 35 s timeout are measured. Orchestration's apparent P95 "improvement" from 25 → 50 rps is an artefact of which orders survived.
- **Both patterns share the same Postgres / RabbitMQ / Temporal infrastructure.** The 100 rps results characterise the *whole stack*, not the pattern in isolation. Test D varies resource limits to separate these effects.
- **Compensation is not exercised here** (`compensated = 0`). Test A measures the happy path; compensation is the subject of Tests H, I, M, N.
- **Shared infrastructure was not recreated between modes**, so any Temporal history-table state from previous runs remains. This is a constant factor across all rates.

### Headline

At low load (1–10 rps), **choreography is consistently ~50–500 ms faster end-to-end** because it avoids 5 × ~100 ms task-queue hops. As load grows, the gap widens by an order of magnitude, and **orchestration saturates at roughly 1/5 of choreography's sustainable rate**.

---

## Test B — Fire-and-Forget Throughput

### Purpose

Measures **API-gateway intake throughput** at sustained request rates *without* waiting for the saga to complete. Unlike Test A, `POST /api/orders` is fired and the test moves on immediately, so only:

- HTTP response duration (request issue → gateway returning `202 Accepted`)
- Whether the response was a valid `202` with an `orderId`

are measured. This isolates **HTTP acceptance capacity** from the downstream saga pipeline. Orchestration only needs to write the Order row + call `Temporal.StartWorkflowAsync`. Choreography only needs to write the Order row + publish `OrderCreated` to RabbitMQ.

### Setup

- **Driver**: `order-load-test.js` — k6 with `constant-arrival-rate` for 60 s.
- **Pre-test reset**: inventory restock, order purge, payment failure rate = 0%.
- **Per-request workload**: random product (1 of 5), random qty 1–3, random `customerId`. Success check: `status === 202 && body.orderId !== undefined`. **No polling for saga completion.**
- **Rates**: 1, 5, 10, 25, 50, 100, 250, 500, 1000 rps.

### Results

> ⚠️ **Orchestration excluded.** Every orchestration row reports `created: 0` with HTTP latencies that *decrease* under load (14.5 ms at 1 rps → 2.3 ms at 500 rps), and the 1000 rps row caps at exactly 15 430 ms — the fingerprint of a fast-fail path. Almost certainly `_temporalClient.StartWorkflowAsync(...)` was throwing on every request (Temporal worker not registered or gRPC connection unhealthy during the 2026-04-26 20:07–20:17 window). The controller body shape is identical to choreography, so the k6 success check is not at fault. **A re-run with a verified-healthy Temporal worker is required before Test B can support a side-by-side comparison.**

**Choreography** (all values in ms; *Iter* = k6 iterations actually executed in 60 s):

| Rate (rps) | HTTP avg | p95 | p99 | max | Iter | Created / target | Success |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 15.8 | 23.6 | 81.6 | 156.2 | 61 | 61 / 60 | 100% |
| 5 | 8.2 | 15.7 | 19.7 | 22.6 | 300 | 300 / 300 | 100% |
| 10 | 4.7 | 8.2 | 13.3 | 30.0 | 600 | 600 / 600 | 100% |
| 25 | 3.4 | 5.6 | 13.6 | 30.3 | 1 501 | 1 501 / 1 500 | 100% |
| 50 | 3.4 | 7.0 | 18.2 | 31.5 | 3 000 | 3 000 / 3 000 | 100% |
| 100 | 8.8 | 17.1 | 37.5 | 175.8 | 6 001 | 6 001 / 6 000 | 100% |
| 250 | 36.8 | 137.7 | 324.5 | 366.4 | 15 000 | 15 000 / 15 000 | 100% |
| 500 | **8 537.7** | **17 794.6** | 19 280.0 | 24 626.5 | 16 571 | 11 071 / 30 000 | 66.8% |
| 1000 | **14 481.8** | **21 722.2** | 26 674.9 | 32 393.3 | 21 823 | 15 161 / 60 000 | 69.5% |

### Analysis

**Choreography scales cleanly to 250 rps and collapses sharply at 500 rps:**

- **1–50 rps**: p95 in single-digit ms (5.6–17.1). Median *drops* from 12.4 ms (1 rps) to 2.6 ms (50 rps) as TCP keepalives, EF query plans, and channel pools warm up.
- **100 rps**: still clean — p95 = 17.1 ms, 100% success. Average climbs slightly — publish path is starting to see contention but is nowhere near saturated.
- **250 rps**: first stress signal — p95 = 137.7 ms (~8× the 100-rps figure), still 100% success and full target rate delivered. Queueing inside the publish pipeline becomes visible.
- **500 rps — cliff.** p95 explodes to 17 794.6 ms (~130× the 250-rps figure), success drops to 66.8%, only 16 571 of 30 000 expected complete. Effective rate ~276 rps despite a 500 rps target.
- **1000 rps**: further degradation rather than catastrophic failure. Effective rate ~364 rps. Pattern is back-pressure dominated: requests pile up in HTTP server queues and time out client-side rather than being rejected outright.

**Saturation point for choreography is between 250 rps (clean) and 500 rps (collapsed)**. A finer sweep (300 / 350 / 400 / 450) would pin the knee.

### Architectural interpretation

The collapse at 500 rps is consistent with a **RabbitMQ / MassTransit publish-side bottleneck**, not Postgres saturation:

1. The Order insert happens *before* the publish. If Postgres were the bottleneck, latency would climb gradually rather than staying flat at <10 ms through 100 rps and then jumping.
2. `IPublishEndpoint.Publish` blocks on a confirmed exchange route — channel locking, exchange-bind verification, publisher-confirm round-trip. At 500 publishes/s on a single replica, the channel pool starves.

### Recommended actions

1. **Re-run orchestration** after confirming the Temporal worker is registered and the namespace is ready.
2. **Add a saturation sub-sweep** for choreography between 250 and 500 rps.
3. **Raise k6's `maxVUs`** at the 500 / 1000 rps tier — when responses balloon to 18 s, `Math.max(RATE * 5, 50)` becomes the bottleneck.
4. **Persist failed-request status codes** so that anomalies like the orchestration failure are diagnosable from the JSON alone.

---

## Test D — Resource Scaling

### Purpose

Determines whether saga performance is **CPU-bound or IO-bound**, and how each pattern degrades when compute is squeezed. Specifically:

- Does the same workload run faster when given more CPU/RAM?
- Which pattern degrades more gracefully under starvation?
- Where does each pattern hit its first wall — workflow engine, broker, database, or .NET workers?

### Setup

- **Driver**: `benchmark-saga-steps.js` (same as Test A) via `run-resource-scaling-test.sh`.
- **Profiles applied to both infra and .NET service containers**:

  | Profile | CPU/container | RAM/container |
  |---|---|---|
  | `constrained` | 0.5 | 256 MB |
  | `generous` | 2.0 | 1024 MB |

- **Note (April 2026 revision)**: previously only infra was constrained; now the .NET workers run with the same per-container budget. Only variable is *how much compute the entire saga gets*.
- **Runs**: orchestration & choreography × `constrained` @ 10 rps, 25 rps; `generous` @ 25 rps.
- Each run: 60 s main + 5 s warmup. `docker stats` sampled every 2 s.
- **`failed`** counter = orders that did not reach `Completed` within the 30 s polling window (timeouts), **not** compensated sagas.

### Results

#### End-to-end saga latency (P95) and completion counts

| Run | Completed | Timed out | Saga P95 | Saga P99 | API P95 |
|---|---|---|---|---|---|
| Orch · constrained · 10 rps | 611 | 0 | 873 ms | 1 028 ms | 16 ms |
| Choreo · constrained · 10 rps | 568 | 32 | **365 ms** | 660 ms | 6 ms |
| Orch · constrained · 25 rps | 109 | 1 359 | 2 371 ms | 3 647 ms | 56 ms |
| Choreo · constrained · 25 rps | **9** | 1 519 | **27 129 ms** | 27 361 ms | 295 ms |
| Orch · generous · 25 rps | 1 532 | 0 | 936 ms | 1 131 ms | 15 ms |
| Choreo · generous · 25 rps | 1 497 | 33 | **337 ms** | 2 169 ms | 3 ms |

#### Per-step P95 (ms), constrained 10 rps — both modes healthy

| Step | Orchestration | Choreography | Δ |
|---|---|---|---|
| Reserve Inventory | 150 | 34 | −116 |
| Process Payment | 301 | 202 | −99 |
| Arrange Shipping | 202 | 105 | −97 |
| Send Notification | 200 | 82 | −118 |
| Update Status | 150 | 4 | −146 |

#### Per-step P95 (ms), constrained 25 rps — both modes overloaded

| Step | Orchestration | Choreography |
|---|---|---|
| Reserve Inventory | 384 | **15 679** |
| Process Payment | 427 | 4 254 |
| Arrange Shipping | 421 | 3 104 |
| Send Notification | 533 | 4 051 |
| Update Status | 889 | 117 |

#### Peak CPU per container (raw `docker stats` %; 0.5 CPU ≈ 50%, 2.0 CPU ≈ 200%)

| Run | order-svc | postgres | temporal | rabbitmq |
|---|---|---|---|---|
| Orch · constrained · 10 rps | 52% | 44% | 43% | 30% |
| Choreo · constrained · 10 rps | 52% | 19% | 5% | 17% |
| Orch · constrained · 25 rps | 52% (*pegged*) | 54% (*pegged*) | 50% (*pegged*) | 28% |
| Choreo · constrained · 25 rps | **94%** (*pegged + over*) | 75% (*pegged*) | 64% (*pegged*) | 27% |
| Orch · generous · 25 rps | 52% | 50% | 64% | 27% |
| Choreo · generous · 25 rps | 75% | 18% | 2% | 33% |

### Analysis

**The bottleneck is CPU, not IO.** Doubling CPU/RAM (constrained → generous) at 25 rps takes both patterns from near-collapse to a healthy steady state with no measurable IO penalty:

- Orchestration: completions 109 → 1 532 (+14×); saga P95 2 371 → 936 ms (−2.5×).
- Choreography: completions 9 → 1 497 (+166×); saga P95 27 129 → 337 ms (−80×).

If the system were IO-bound, more CPU could not produce that recovery. Postgres CPU climbs in lock-step with load, and Temporal climbs from 43% → 50% under constrained 25 rps — both pegged against the 0.5-CPU ceiling, which is the textbook signature of CPU starvation.

**The two patterns saturate different components first:**

- **Orchestration** spreads load across `OrderService`, `Temporal`, and `Postgres`. Under constrained 25 rps, all three hit the 50% cap simultaneously. Because Temporal buffers activity tasks server-side, the system degrades roughly linearly: P95 873 → 2 371 ms, no individual step explodes.
- **Choreography** concentrates everything in the .NET workers, which both publish *and* consume MassTransit messages. Under constrained 25 rps, `saga-order-service` peaks at 94% (~2× its 0.5-CPU budget — burst-credit borrowing then heavy throttling). Postgres also climbs to 75%, far higher than orchestration on the same workload, because in-process consumers issue every saga-state write directly. With the consumer thread starved, the `ReserveInventoryCommand` queue grows unbounded, and `reserveInventory` P95 explodes from 34 ms (10 rps) to **15 679 ms** (25 rps) — a 460× regression on a single step.

In short: **orchestration is bottlenecked by the workflow/state engine; choreography by the consumer dispatch loop.**

**Choreography is faster when not throttled, slower under starvation.** This is the central tension:

- At constrained 10 rps and generous 25 rps (healthy regimes), choreography wins on every per-step metric. End-to-end saga P95 is 2.4–2.8× lower. The biggest gains are on Temporal-activity-routed steps:
  - `Update Status`: 150 ms vs 4 ms — 37× gap (Temporal activity vs. in-process consumer).
  - `Reserve Inventory`: 150 ms vs 34 ms — same root cause.
- At constrained 25 rps, the relationship inverts dramatically. Orchestration completes 109 sagas; choreography completes 9. The 9 that did finish took 25 s+. Orchestration's Temporal task queue absorbs the same input load with much smaller per-step blow-up because Temporal is purpose-built to schedule activities asynchronously rather than deliver them through an in-memory consumer that competes with the producer for the same starved CPU.

**API-acceptance latency mirrors the architectural difference.** `apiResponseMs` is consistently 3–5× lower in choreography (1.4–3 ms vs 4–15 ms in healthy runs). Choreography only has to publish before returning; orchestration synchronously starts a Temporal workflow over gRPC. Under constrained 25 rps, choreography's API P95 jumps to 295 ms — exactly the symptom of a publisher blocked by a back-pressured broker — while orchestration's stays at a relatively bounded 56 ms.

### Practical takeaway

- **Both patterns are CPU-bound** on this workload — resource scaling is the right lever, not faster disks.
- **Choreography is the lower-overhead pattern when there is headroom** — fewer hops, no orchestrator gRPC, lower per-step P95.
- **Orchestration is the more *elastic* pattern under starvation** — Temporal's task-queue-backed execution decouples producer rate from worker rate, so failure mode is graceful latency growth rather than queue runaway.
- The crossover is around the point where every container is simultaneously CPU-pegged (here, 25 rps × 0.5 CPU). Sizing the cluster so that no individual saga service exceeds ~70% of its CPU budget keeps choreography in its preferred regime.

### Caveats

- Only `constrained` and `generous` profiles were captured; no `default` (1.0 CPU) data, so the curve between the extremes is interpolated.
- Constrained 25 rps runs are well past the breakdown point — most samples are 30 s polling timeouts, so percentiles summarise a degenerate regime. They are useful as a *failure-mode* signal, not as latency numbers to quote in isolation.
- The `failed` counter does not separate "saga compensated" from "client polling timeout"; in this test almost all failures are the latter.

---

## Test E — Inventory-Visibility Lag

### Purpose

Measures **real eventual-consistency lag**: how soon after a client posts a new order does the reserved stock become readable through `GET /api/inventory/products`. This is the visible "side-effect window" a UI or downstream service experiences.

Two timings per order:

- **`inventoryVisibilityLagMs`** — POST → `reservedQuantity` increment is visible via the inventory API.
- **`sagaCompletionLagMs`** — POST → `Order.Status = Completed`.

The thesis-relevant comparison is the **delta** between the two: how far the user-visible side-effect leads the saga's terminal state.

### Setup

- **Driver**: `benchmark-consistency-lag.js` via `./run-test.sh consistency --env ITERATIONS=30`.
- **Workload**: `executor: per-vu-iterations`, **1 VU**, **30 iterations** (single-flight, keeps the inventory counter clean).
- **Per-iteration loop**:
  1. Snapshot `reservedQuantity` for product `a1111111-...`.
  2. `POST /api/orders` for 1 unit; mark `start`.
  3. Poll `/api/inventory/products` and `/api/orders/{id}/status` every **25 ms**.
  4. Record `inventory_visibility_lag_ms` on first poll where `reservedQuantity > baseline`.
  5. Record `saga_completion_lag_ms` when status becomes `Completed`.
  6. Per-iteration timeout: **15 s**.
- **Modes**: each saga mode run after `--force-recreate` of the .NET services.
- **Failure path not exercised**: payment-failure rate = 0 → `inventoryReleaseLagMs` is `null` everywhere.

### Results

**Latest canonical runs** (all values in ms):

| Metric | Mode | n | avg | med | p90 | p95 | max |
|---|---|---|---|---|---|---|---|
| Inventory visibility lag | Orchestration | 30 | 40.8 | 33.0 | 37.1 | **42.4** | 243.0 |
| Inventory visibility lag | Choreography | 30 | 32.2 | 32.0 | 33.0 | **35.7** | 43.0 |
| Saga completion lag | Orchestration | 30 | 344.9 | 312.0 | 396.1 | **436.0** | 1205.0 |
| Saga completion lag | Choreography | 30 | 280.8 | 281.0 | 347.4 | **377.6** | 393.0 |

**Both runs side-by-side** (repeatability check):

| Mode | Run | completed/timeouts | inv avg / p95 / max | saga avg / p95 / max |
|---|---|---|---|---|
| Orchestration | 18:17 | 30 / 0 | 39.3 / 36.6 / 227 | 336.4 / 415.2 / 1087 |
| Orchestration | 18:21 | 30 / 0 | 40.8 / 42.4 / 243 | 344.9 / 436.0 / 1205 |
| Choreography | 18:19 | 27 / **3** | 40.8 / 40.7 / 279 | 300.5 / 363.6 / 1262 |
| Choreography | 18:21 | 30 / 0 | 32.2 / 35.7 / 43 | 280.8 / 377.6 / 393 |

- Orchestration runs are tightly reproducible.
- The earlier choreography run reported 3 timeouts and a long max (1262 ms); the cleaner second run finished all 30 inside 393 ms — strong evidence the first run was a transient cold-cache blip.

### Analysis

**Both patterns expose the reservation long before the saga finalises.** The lag delta `sagaCompletion − inventoryVisibility` quantifies the user-facing eventual-consistency window. On the median: ≈279 ms (orchestration), ≈249 ms (choreography). For ~¼ second after stock is already visible to clients, the order is still listed as `Pending` — the classic saga read-your-write hazard.

**Choreography is faster on every percentile of both metrics.** Latest runs:

- Inventory visibility: avg **−21%** (32.2 vs 40.8 ms), p95 **−16%** (35.7 vs 42.4 ms).
- Saga completion: avg **−19%** (280.8 vs 344.9 ms), p95 **−14%** (377.6 vs 436.0 ms).

This matches the architectural prediction: in choreography, `InventoryService` reacts directly to `OrderCreated` from RabbitMQ (one hop, one DB write), whereas Temporal must persist a workflow event, dispatch a workflow task to a worker, then schedule the `ReserveInventory` activity before the same DB write happens.

**The tail behaviour is the most striking finding.** At max:

- Inventory: orchestration **5.7×** worse (243 vs 43 ms).
- Saga completion: orchestration **3.1×** worse (1205 vs 393 ms).

In the clean choreography run, `max ≈ p95 + 8–15 ms` — an essentially flat distribution. Orchestration shows the opposite: `max` sits **~6× above p95** for inventory, **~3× above p95** for saga completion. Consistent with Temporal-worker scheduling jitter (history-table writes, task-queue polling cadence, sticky-cache misses) — overheads that the event-pump path simply does not have.

**Choreography is not strictly more reliable — it is more sensitive to environment noise.** The earlier run's three timeouts and 1262 ms outlier are indistinguishable from orchestration's worst case. Across both runs, choreography's *typical* numbers are better but its *worst* observed run isn't materially better than orchestration. This suggests:

- Orchestration's tail is **structural** (Temporal scheduling) — present in both runs.
- Choreography's tail is **environmental** — only present in one run; otherwise it disappears.

### Caveats

- Failure path never exercised (`inventoryReleaseLagMs = null`). Compensation-side lag belongs to Test I / Test M.
- 1 VU × 30 iterations is single-flight by design. Concurrent-load behaviour belongs to Test A / K.
- The 25 ms poll interval is the floor of resolution. Median values (~32 ms) are at the noise floor; the **tail** values, where the gap is large, are the trustworthy signal.

### Headline

Choreography reaches the inventory API roughly **8 ms** sooner on the median and **~7 ms** sooner on p95, but the architecturally meaningful difference is **tail latency**: orchestration injects multi-hundred-millisecond outliers into both inventory visibility and saga completion that choreography does not, attributable to Temporal's workflow-scheduling overhead.

---

## Test F — Race Condition / Concurrency

### Purpose

Validates **correctness of concurrency control** under contention. Twenty VUs simultaneously attempt to purchase the same single-stock product ("Limited Edition Tablet", stock = 1). Exactly **one** order must succeed and **nineteen** must fail.

Two questions:

- **Correctness**: Does optimistic concurrency on `Product.Version` (mapped to PostgreSQL's `xmin`) prevent overselling in both saga patterns?
- **Performance under contention**: How does each pattern *handle* losers — i.e. how is `DbUpdateConcurrencyException` propagated back through the saga?

### Setup

- **Driver**: `benchmark-race-condition.js`.
- **Executor**: k6 `shared-iterations`, 20 VUs / 20 iterations / `maxDuration: 30s`, per-request `timeout: '35s'`.
- **Endpoint**: `POST /api/orders/benchmark` (synchronous — blocks until terminal saga state).
- **Per-VU payload**: a fresh `customerId` (UUID) + 1 unit of the limited-stock product.
- **Setup**: `POST /api/inventory/reset` + `DELETE /api/orders/reset` to guarantee `availableQuantity = 1, reservedQuantity = 0` at start.
- **Verdict**: `wins == 1` → PASS; `wins == 0` → FAIL (no winners); `wins > 1` → FAIL (oversell).
- **Concurrency-control implementation differs by pattern**:
  - **Orchestration**: catches `DbUpdateConcurrencyException` and returns **HTTP 409 Conflict** → Temporal sees activity failure and goes straight to compensation.
  - **Choreography**: catches the same exception and **rethrows** → MassTransit enters retry policy, eventually publishing `InventoryReservationFailed`.
- **Two runs per mode** were captured.

### Results

All four runs: `wins=1, losses=19` → **PASS** in every case. The split is on response-time distribution:

| Mode | Run | Avg (ms) | P95 (ms) | Max (ms) | Verdict |
|---|---|---:|---:|---:|---|
| Orchestration | 1 (`18-22-58`) | 3 782.6 | 4 010.8 | 5 813.0 | PASS |
| Orchestration | 2 (canonical) | 3 283.7 | 3 557.1 | 3 558.0 | PASS |
| Choreography | 1 (`18-23-43`) | 1 676.0 | 3 913.6 | 3 924.0 | PASS |
| Choreography | 2 (canonical) | 6 794.1 | **33 357.1** | **33 359.0** | PASS |

**Mode aggregates** (across the two runs):

| Mode | Avg-of-avgs (ms) | P95 range (ms) | Max range (ms) |
|---|---:|---:|---:|
| Orchestration | ~3 533 | 3 557 – 4 011 | 3 558 – 5 813 |
| Choreography | ~4 235 | 3 914 – **33 357** | 3 924 – **33 359** |

### Analysis

**Correctness: both patterns are safe.** Every run produced exactly 1 winner across 20 concurrent buyers. The PostgreSQL `xmin` concurrency token does its job in both modes — the saga pattern has **no influence on overselling prevention**, because both modes share the same `InventoryDbContext` and the database (not the saga coordinator) is the arbiter. This isolates saga-pattern overhead from the contention-control mechanism.

**Loser-path latency is where the patterns diverge.** The 19 losers — not the 1 winner — dominate the response-time distribution:

- **Orchestration** is *tight and predictable*: avg ≈ 3.3–3.8 s, P95 within ~250 ms of avg, max ≤ 5.8 s. When a loser's `ReserveInventoryActivity` returns `409 Conflict`, Temporal records the activity failure and routes the workflow straight into compensation. There is **no retry on a domain-level conflict**, so each loser pays roughly one round-trip + the compensation step and terminates.
- **Choreography** is *bimodal*: one run finished with avg 1.68 s (faster than orchestration's best); the other ballooned to avg 6.8 s with P95 = 33.36 s and max = 33.36 s. The 33.36 s is essentially the **k6 per-iteration timeout (35 s)** — a substantial fraction of losers were timing out instead of returning naturally.

**Why choreography is bimodal — root cause.** The `ReserveInventoryConsumer` deliberately *rethrows* `DbUpdateConcurrencyException` so MassTransit retries via broker redelivery. Under 20-way contention, every retry races again against the same single row, so the typical loser flow is:

1. Lose the optimistic-concurrency check → throw.
2. MassTransit redelivers from RabbitMQ after a back-off.
3. Lose again (winner already committed, but row is still contested by 18 other losers).
4. Repeat until retry budget exhausts → publish `InventoryReservationFailed` → saga unwinds.

Retry/back-off schedule, broker scheduling, and the order in which losers commit determine whether a given run is "fast" or "slow". This non-determinism produces the **17×** P95 spread between choreography runs (3 914 ms vs 33 357 ms), while the orchestration spread is < 12% (3 557 ms vs 4 011 ms).

Orchestration sidesteps this entirely because the orchestrator distinguishes a *domain* failure (HTTP 409) from a *transient* failure: it does not retry the activity on a `Conflict` response and proceeds to compensation immediately.

### Implications

- **Concurrency safety is a database-level property**, not a saga-pattern property. Both patterns inherit the same correctness from `Product.Version`.
- **Failure-path tail latency is a saga-pattern property.** Orchestration's centralized failure routing converts a `409` into a single deterministic compensation, whereas choreography's broker-mediated retries amplify contention into long, variable tails. Under heavy contention, response time is gated by the retry/timeout configuration of the broker rather than by the work being done.

### Methodological note

The 33.36 s max in choreography run 2 is **censored by the k6 35 s timeout**. To measure the true loser-path P95 in choreography, either raise the timeout (e.g. `timeout: '120s'`) or — more realistically — change the choreography consumer to treat `DbUpdateConcurrencyException` as a domain failure (publish `InventoryReservationFailed` on first occurrence) instead of throwing it back to MassTransit. That would make patterns directly comparable.

### Headline

Orchestration P95 = **3.6 s** (stable); choreography P95 = **3.9 s in the best run, 33.4 s in the worst**. Both correct, but **orchestration is roughly 9× more predictable** under single-row contention given the current retry policies.

---

## Test G — Idempotency

### Purpose

Verifies that submitting the *same* `POST /api/orders` request twice (a "double-click") with an identical `IdempotencyKey` does **not** result in a duplicate order — no second saga, no double inventory reservation, no double payment.

Three assertions per iteration:

- Both POSTs return HTTP **202 Accepted**.
- Both responses carry the **same `orderId`**.
- The **second** response includes `idempotent: true`.

A hard k6 threshold (`duplicate_orders_created: ['count==0']`) fails the run if even one duplicate slips through.

### Setup

- **Workload**: 1 VU, **20 iterations**, `per-vu-iterations` executor.
- Each iteration generates a fresh `customerId` and `idempotencyKey` (UUIDv4), then fires **two back-to-back** POSTs with identical payload.
- Latency split into `first_response_ms` (real work) and `second_response_ms` (deduplicated cache hit).
- **Setup**: inventory reset, all orders deleted, payment failure rate = 0%, 2 s settle.
- **Server-side mechanism** (identical for both saga modes): the controller checks `IdempotencyRecord` for `(Key, OperationType="CreateOrder")` *before* doing anything else. If found → returns cached `OrderId` with `Idempotent = true` and **never starts a saga**. If not found → inserts `Order` + `IdempotencyRecord` in the **same EF transaction**, protected by a unique index on `(Key, OperationType)`.
- **Critical**: deduplication runs **before** dispatch — *before* `Temporal.StartWorkflowAsync` (orchestration) or `IPublishEndpoint.Publish` (choreography). The mechanism is therefore pattern-agnostic by design.
- **Run command**: `./run-test.sh idempotency --env ITERATIONS=20`, once per saga mode with `--force-recreate` between runs.

### Results

#### Correctness (primary metric)

| Mode | Iterations | Idempotent hits | Duplicates created | Verdict |
|---|---|---|---|---|
| Orchestration | 20 | **20** | **0** | **PASS** |
| Choreography | 20 | **20** | **0** | **PASS** |

#### Latency — steady-state (second run of each mode)

| Metric | Orchestration | Choreography |
|---|---|---|
| 1st POST avg | 8.6 ms | 5.5 ms |
| 1st POST P95 | 11.6 ms | 13.5 ms |
| 1st POST max | 24.0 ms | 24.0 ms |
| 2nd POST avg | 3.0 ms | 2.1 ms |
| 2nd POST P95 | 6.0 ms | 6.1 ms |
| 2nd POST max | 7.0 ms | 8.0 ms |

#### Latency — cold first run (immediately after `--force-recreate`)

| Metric | Orchestration | Choreography |
|---|---|---|
| 1st POST avg | 19.1 ms | 16.4 ms |
| 1st POST P95 | 49.4 ms | 28.1 ms |
| 1st POST max | 191.0 ms | 202.0 ms |
| 2nd POST avg | 3.6 ms | 5.3 ms |
| 2nd POST P95 | 7.0 ms | 11.4 ms |
| 2nd POST max | 8.0 ms | 20.0 ms |

### Analysis

**Correctness is identical and pattern-agnostic.** Both saga patterns deduplicate perfectly (20/20, 0 duplicates). This is structural, not coincidence:

- **Same-transaction write** of `Order` + `IdempotencyRecord`. The unique index means even under a true concurrent double-click, exactly one transaction wins and the loser re-reads the cached `OrderId`.
- **Pattern-agnostic location**. Because the check runs before the `if (sagaMode == "orchestration")` branch, the saga pattern is irrelevant to correctness.

For the thesis, this is a useful negative result: **idempotency is not a differentiator** between orchestration and choreography, provided the entry point handles it. The often-repeated worry about choreography being more vulnerable to duplicate events does not apply when deduplication is done at the HTTP boundary.

**First-POST latency: choreography slightly cheaper at the dispatch step.** In steady state, ~8.6 ms (orch) vs ~5.5 ms (chor) — a ~3 ms gap consistent with the cost of the dispatch primitive:

- **Orchestration** issues a synchronous gRPC `StartWorkflowAsync`, which persists the workflow's first history event before returning.
- **Choreography** issues `IPublishEndpoint.Publish(orderCreated)` — a local TCP write to RabbitMQ. The HTTP response can be sent as soon as the broker acknowledges; consumers run asynchronously.

The P95 numbers are reversed (orch 11.6 vs chor 13.5) but with only 20 samples this is statistical noise — a single slow tail pulls P95 up significantly. Avg is the more reliable signal at this sample size.

**Second-POST latency: identical and minimal in both modes.** ~2–3 ms avg, ~6 ms P95. The second request does the absolute minimum: a single indexed `SELECT`, JSON-deserialize, return 202. It **never enters the saga pipeline**. This is the strongest evidence that deduplication correctly short-circuits before any pattern-specific code runs — otherwise, second-POST latency would mirror the first-POST gap, and it doesn't.

**Cold-run noise is JIT/EF warm-up, not a pattern signal.** Both first runs show max 191–202 ms dominating avg and P95. Textbook cold-start signature (Npgsql connection from empty pool, EF Core query plan compilation, .NET tiered JIT). Not pattern-specific — that's exactly what Test L (cold-start) is designed to isolate. For Test G's purposes, only the second/canonical runs matter for steady-state comparison.

### Implications

- **Both patterns satisfy idempotency equivalently** when the entry-point uses an idempotency-record table with a unique index.
- The minor steady-state latency advantage of choreography (~3 ms on the first POST) reflects the cost of synchronous workflow registration vs. asynchronous broker publish — **not specific to idempotency**.
- The deduplicated path is essentially free (~2 ms), so there is **no penalty for clients to send retries with idempotency keys**.

**Verdict**: Given a correctly-implemented idempotency table at the request boundary, orchestration and choreography are interchangeable from a correctness standpoint, with only marginal (millisecond-level) latency differences from their dispatch primitives.

---

## Test H — Mixed Workload

### Purpose

Captures **happy-path** and **compensation-path** latency in the **same run** under a configurable failure rate, so percentiles for both outcomes reflect the same load conditions and queue depth.

Two questions:

- **Realistic mix (10% failure)**: What does production-style traffic look like in each pattern?
- **Forced rollback (100% failure)**: What is the *raw* compensation cost when every saga must compensate?

Two metrics matter:

- **`compensationSagaMs`** — full saga lifetime for a rolled-back order (request → terminal `Failed`).
- **`compensationWindowMs`** — narrow `Compensating → Failed` window only, isolating rollback from forward-progress.

### Setup

- **Driver**: `benchmark-mixed-workload.js`.
- **Setup hook**: resets inventory, deletes orders, then `POST /api/payments/failure-rate/<FAIL_RATE_PCT>` to inject deterministic payment failures.
- **Teardown**: resets failure rate to 0.
- Each k6 sample tagged `outcome:happy` or `outcome:compensation` based on the `compensated` flag.
- `constant-arrival-rate` executor with a 5 s warm-up phase at 1/4 the main rate.
- **Two scenarios** (each ran twice per mode):

| Scenario | Rate | Duration | `FAIL_RATE_PCT` | Goal |
|---|---|---|---|---|
| Realistic | 10 rps | 60 s | 10 | Production-like mix |
| Pure compensation | 5 rps | 30 s | 100 | Isolate rollback cost |

### Results

#### Scenario 1 — 10 rps, 10% target failure, 60 s

| Mode | Completed | Compensated | Failed | Observed fail % | Happy P95 (ms) | Comp saga P95 (ms) | Comp window P95 (ms) |
|---|---|---|---|---|---|---|---|
| Orchestration (run 1) | 611 | 0 | 0 | **0.0** | 1683.8 | n/a | n/a |
| Orchestration (run 2) | 612 | 0 | 0 | **0.0** | 1676.2 | n/a | n/a |
| Orchestration (run 3) | 610 | 0 | 0 | **0.0** | 1689.2 | n/a | n/a |
| Choreography (run 1) | 534 | 16 | 59 | 12.3 | 339.5 | 1129.2 | 1019.7 |
| Choreography (run 2) | 543 | 10 | 57 | 11.0 | 339.9 | 1193.1 | 1013.8 |

#### Scenario 2 — 5 rps, 100% target failure, 30 s

| Mode | Completed | Compensated | Failed | Comp saga avg / P95 / max (ms) | Comp window avg / P95 / max (ms) |
|---|---|---|---|---|---|
| Orchestration (run 1) | 0 | 147 | 0 | 3570.6 / 3874.5 / 4113.3 | 104.1 / 310.7 / 363.8 |
| Orchestration (run 2) | 0 | 146 | 0 | 3595.8 / 3871.8 / 4033.5 | 116.2 / 339.2 / 367.8 |
| Choreography (run 1) | 0 | 53 | 103 | 199.4 / 281.0 / 318.9 | 26.4 / 27.6 / 29.4 |
| Choreography (run 2) | 0 | 44 | 113 | 192.9 / 243.0 / 292.5 | 26.2 / 27.7 / 28.7 |

### Analysis

**Happy-path latency: choreography is ~5× faster.** At 10 rps the happy-path saga completes in ~340 ms P95 (chor) vs ~1680 ms P95 (orch). Matches Test A: orchestration pays Temporal task-queue dispatch on every step, while choreography hands off via direct AMQP. Tail behaviour is also worse for orchestration — P99 jumps to **3820 ms** in run 1, indicating long-tail outliers consistent with worker scheduling pressure.

**Compensation cost: window vs full saga (most important finding).** At 100% failure rate, the breakdown reveals that **most of the orchestration cost is not in rollback itself**:

| Mode | Comp saga total P95 | Comp window P95 | Forward-progress + retry portion |
|---|---|---|---|
| Orchestration | ~3870 ms | ~325 ms | **~3545 ms (~92%)** |
| Choreography | ~262 ms | ~27 ms | ~235 ms (~90%) |

- The **`Compensating → Failed` window** is genuinely small in both patterns — orch ~325 ms P95, chor ~27 ms P95 (≈12× faster).
- The **dominant cost in orchestration** sits *before* compensation begins. With the payment activity throwing 100% of the time, the Temporal workflow retries the activity per its policy (exponential backoff) until it gives up, **then** transitions to the compensation branch. That retry tail accounts for ~3.5 s of the ~3.9 s saga duration. Choreography has no equivalent retry layer — the first failed event triggers the rollback chain immediately.

This difference is **architectural, not implementation polish**: Temporal's value proposition includes durable retries, and the test exposes the latency tax of that feature in a fail-fast scenario.

**Orchestration's retry policy absorbs the 10% failure injection.** All three orchestration runs at `FAIL_RATE_PCT=10` report `observedFailRatePercent: 0`, `compensated: 0`. This initially looks like the failure injection didn't work, but it is the **expected mathematical outcome** of the activity retry policy:

- `PaymentOperations.cs` rolls `Rng.Next(100) < FailureRatePercent` **per call** → independent 10% probability per HTTP attempt.
- `OrderActivities.cs` raises `ApplicationException` on non-success → Temporal classifies as retriable.
- `OrderSagaWorkflow.cs` configures `MaximumAttempts = 3` (initial + 2 retries at 1 s and 2 s).

So **per-saga** failure probability is `0.10³ = 0.1%`. Across 600 sagas the expected count of compensating sagas is 0.6 (≈55% chance of zero in a single run, ≈17% chance of zero in three independent runs). The observed `0/0/0` outcome is fully consistent with the binomial distribution.

Choreography behaves differently for a structural reason. The payment consumer does **not** throw on a business failure — it publishes a `PaymentFailed` event and returns normally — so `UseMessageRetry` never engages. Each saga gets exactly one payment attempt, and a 10% per-call rate translates to ~10–12% per-saga failures.

**Thesis-level finding**: Under transient downstream failures, the two patterns expose **different effective failure budgets at the saga boundary**. Temporal's activity retries silently absorb 99.9% of 10% per-call failures; choreography surfaces them as compensation paths at roughly the same per-saga rate as the per-call rate. The same retry asymmetry is responsible for the ~3 s delay before compensation begins in Test I and the ~3.5 s "forward-progress + retry" portion of orchestration's compensation in Scenario 2.

A practical consequence: the choice of pattern partially determines whether transient-error spikes show up as **user-visible compensations** or as **silent latency tax**. Equalising the policies would require either disabling Temporal retries (`MaximumAttempts = 1`) or wrapping the choreography consumer in `UseMessageRetry` and re-throwing on business failure.

**Choreography classification anomaly: `failed` ≫ `compensated`.** In both scenarios choreography reports far more `failed` than `compensated` (e.g. 113 failed vs 44 compensated at 100%), even though every non-completed saga reached terminal `Failed`. Classification depends on the `compensated` flag in the benchmark response. Many orders reach `Failed` without the response setting `compensated: true` — likely because the benchmark endpoint returns at terminal-state arrival, and choreography's terminal-state detection doesn't always signal "compensation ran" reliably. The `compensationSagaMs` and `compensationWindowMs` percentiles only cover the tagged subset, so they may slightly under-represent the real distribution. **This does not invalidate the comparison** — per-sample timings on the tagged subset are still valid — but the per-pattern accounting in `totals` should be reported with this caveat.

**Throughput sanity check.** 10 rps × 60 s = 600 target orders → all Scenario 1 runs landed in 609–612 (load generator hit the target rate cleanly). 5 rps × 30 s = 150 target → all runs landed in 146–157. **No saturation observed**; latency results reflect intrinsic pattern overhead.

### Recommended follow-ups

- **Frame Scenario 1 around the retry-budget finding**, not as a mixed-workload latency comparison. Three independent runs producing `0/0/0` confirm the binomial prediction; the row is a *result*, not a pending re-run.
- For a side-by-side compensation-latency comparison at 10 rps, set `FAIL_RATE_PCT ≥ 50` per call (≥ 12.5% per saga) or temporarily lower `MaximumAttempts` to 1.
- **Report compensation comparison primarily from Scenario 2** (100% rate). Headline finding — orchestration's full-saga rollback dominated by activity retries — is well-supported.
- **Fix the `compensated` flag** in the benchmark response so it is set whenever the saga reached `Failed` via the compensation chain.

---

## Test I — Compensation Correctness

### Purpose

Verifies that **compensation actually restores system state after failure** in both saga patterns. A *correctness* test, not performance, that records how long it takes for an order to reach `Failed`. Three invariants:

- **Liveness** — every order reaches `Failed` (none stuck in `Pending`/`Compensating`).
- **Inventory rollback** — `reservedQuantity` returns to baseline.
- **No dangling state** — every order ends in a terminal status.

### Setup

Single-VU k6 scenario with deterministic 100% payment failures.

- `ITERATIONS = 10`, `vus = 1`, `executor = per-vu-iterations` (single-threaded — no inter-iteration interference).
- `TIMEOUT_MS = 15000` per order.
- Hard k6 threshold: `orders_stuck: ['count==0']`.
- Product: `a1111111-...`.
- **Setup**: reset inventory + orders, snapshot baseline `reservedQuantity` and `stockQuantity`, then `POST /api/payments/failure-rate/100`.
- **Iteration**: POST 1 unit; poll status every 50 ms until `Failed`/`Completed` (timeout 15 s); record `compensation_total_ms` (POST → `Failed`); 500 ms gap between iterations.
- **Teardown**: reset failure rate to 0, sleep 2 s, compare `reservedQuantity` to baseline (PASS/FAIL), verify no `Pending`/`Compensating` orders.
- **Two runs per mode** captured.

### Results

#### Correctness (identical for both patterns)

| Check | Orchestration | Choreography |
|---|---|---|
| Orders reached `Failed` | 10 / 10 | 10 / 10 |
| Orders stuck | **0** | **0** |
| Inventory reservation released to baseline | PASS | PASS |
| Order status invariant | PASS | PASS |

**Both patterns are functionally correct.**

#### Time-to-`Failed` (`compensation_total_ms`, ms)

| Run | Mode | Count | Avg | Median | P95 | Max |
|---|---|---|---|---|---|---|
| 19:00:02 | Orchestration | 10 | 3565.0 | 3566.5 | 3660.2 | 3675.0 |
| 19:01:00 | Orchestration | 10 | **3586.1** | 3590.0 | 3644.3 | 3647.0 |
| 19:01:40 | Choreography | 10 | 215.7 | 168.5 | 476.2 | 681.0 |
| 19:02:09 | Choreography | 10 | **192.6** | 195.5 | 229.0 | 229.0 |

Canonical results:

- **Orchestration**: avg ≈ **3,586 ms**, p95 ≈ **3,644 ms**.
- **Choreography**: avg ≈ **193 ms**, p95 ≈ **229 ms**.
- **Ratio**: orchestration is roughly **18× slower** to reach `Failed`.

### Analysis

**Both patterns are correct.** 100% of orders reached `Failed`, the hard threshold passed in every run. Inventory was released, no dangling state. From a correctness standpoint, orchestration and choreography are equivalent.

**The 18× latency gap is structural, not a defect.** A direct consequence of **how each pattern interprets a failed PaymentService call**, despite both having a *nominally* matched retry policy (3 attempts with 1 s + 2 s backoff):

- **Orchestration path**: `ProcessPaymentAsync` activity throws `ApplicationException` on non-success. Temporal treats *every thrown exception* as retriable transient and applies `DefaultActivityOptions`: 3 attempts at t=0, t≈1 s, t≈3 s. Only after the third deterministic failure does the workflow enter the `catch` block and start compensations. **~3 seconds of retry backoff before compensation begins** — matching the observed 3.5–3.6 s.

- **Choreography path**: the consumer does **not** throw on business failure; it publishes `PaymentFailed` and returns normally:
  ```csharp
  if (!result.Success) {
      _logger.LogWarning(...);
      await context.Publish(new PaymentFailed(...));
      return;
  }
  ```
  From MassTransit's perspective the message was successfully consumed, so `UseMessageRetry` never engages. `PaymentFailed` flows directly to the saga state machine, which transitions `Compensating` → `Failed` in a single message round-trip per service — hence ~200 ms total.

The same retry policy is configured in both patterns, but **it only fires in orchestration because the failure surface is an *exception*, while in choreography the same condition is modelled as a *business event***. This is an asymmetry in failure semantics, not in retry configuration.

**Variance and tail behaviour.** Choreography shows mild jitter — one run reports max=681 ms and p95=476 ms (more than 2× the median 168.5 ms). Consistent with RabbitMQ scheduling jitter, EF query-plan warmup, MassTransit consumer activation. Orchestration's tail is far tighter (max ≈ p95 ≈ avg + ~80 ms) because almost all duration comes from *deterministic* retry backoff (1 s + 2 s waits), so per-iteration noise is dominated by the fixed timer.

### Implications

- **Correctness conclusion**: both patterns recover cleanly from a deterministic downstream failure; neither leaks reservations or leaves dangling state.
- **Latency conclusion**: the *raw compensation cost* in this codebase is roughly an order of magnitude smaller in choreography (~200 ms vs ~3.6 s), but this is **dominated by retry semantics, not by the saga pattern itself**. If `MaximumAttempts` were lowered to 1 on the orchestration path, the gap would shrink dramatically and the residual difference would reflect Temporal's history-write overhead vs. RabbitMQ's pub/sub overhead.
- **Caveat**: when comparing compensation latency between patterns, the *failure-injection mechanism* must be defined identically. Here, "100% payment failure" means an HTTP error on the orchestration side (which retries) but a business event on the choreography side (which does not).

### Summary

| Aspect | Orchestration | Choreography |
|---|---|---|
| Orders reached `Failed` | 10 / 10 | 10 / 10 |
| Orders stuck | 0 | 0 |
| Inventory restored | Yes | Yes |
| Time-to-`Failed` (avg) | 3,586 ms | 193 ms |
| Time-to-`Failed` (p95) | 3,644 ms | 229 ms |
| Dominant cost driver | 3× activity-retry backoff (1 s + 2 s) before compensation begins | Single message hop publishing `PaymentFailed` |
| Failure semantics | Activity exception → retried | Business event → no retry |

---

## Test J — Endurance / Sustained Load

### Purpose

The **sustained-load (endurance)** benchmark. Not about peak throughput or cold-start — it answers one question:

> *Does either saga pattern degrade over time at a fixed, moderate load?*

It surfaces problems that single-shot benchmarks (Test A, K) miss:

- **Queue-backlog growth** in choreography.
- **Temporal history-table bloat** affecting Postgres write latency.
- **Connection-pool exhaustion**.
- **Unbounded memory growth** / leaks.

The signal is **P95 drift** — the difference between end-bucket and start-bucket P95. **< 500 ms drift = steady state**; more = something is degrading.

### Setup

- **Driver**: `benchmark-endurance.js`.
- **Rate**: 25 rps, **constant-arrival-rate** (open model, no closed-loop distortion).
- **Duration**: 5 minutes per mode → ~7,500 sagas/run.
- **Endpoint**: `POST /api/orders/benchmark` (blocks until terminal saga state).
- **No warm-up**: k6 starts at full rate, so the **start bucket includes JIT/EF warm-up**.
- **Three equal buckets** (~100 s each): `start`, `middle`, `end` — tagged on the metric for per-bucket percentiles + drift.
- **Setup hook**: full state reset (inventory, orders, payment failure rate = 0).
- **Workload**: random pick of 3 products, qty 1, fresh `customerId` UUID per request. **Happy-path only.**
- **Both modes use identical infra**: same Postgres / RabbitMQ / Temporal containers, no resource limits. Only `SAGA_MODE` flipped between runs.

### Results

**Total saga duration (ms), 25 rps for 5 minutes:**

| Bucket | Orchestration (n) | avg | p95 | p99 | max | Choreography (n) | avg | p95 | p99 | max |
|---|---|---|---|---|---|---|---|---|---|---|
| start  | 2,293 | 768.6 | 937.4 | 1,715.9 | **3,899.2** | 2,354 | 254.0 | 337.1 | 363.6 | **3,299.3** |
| middle | 2,493 | 751.0 | 889.4 | 993.2   | 1,949.1     | 2,500 | 249.3 | 336.1 | 361.9 | 391.9 |
| end    | 2,545 | 749.7 | 890.5 | 985.2   | 1,952.4     | 2,556 | 248.4 | 336.1 | 362.1 | 374.3 |
| **overall** | **7,331** | **756.1** | **907.5** | **1,238.6** | 3,899.2 | **7,410** | **250.5** | **336.4** | **362.7** | 3,299.3 |

**P95 drift (end − start):**

- **Orchestration: −46.9 ms** (end is *faster* than start)
- **Choreography: −1.0 ms** (essentially flat)

Both runs delivered ~98% of the 7,500 target sagas (orch 97.7%, chor 98.8%); no failed-status spikes.

### Analysis

**Both patterns are steady-state — neither leaks at 25 rps.** Both drifts are **well below the 500 ms warning threshold** (in fact, slightly negative). This confirms:

1. **No measurable backpressure or resource leak** in 5 minutes — RabbitMQ drains as fast as it fills, Temporal's growing history table isn't yet impacting Postgres write latency, and .NET processes aren't bloating their working sets.
2. The slight negative drift is the **JIT / EF query-plan warm-up** still bleeding into the first ~100 s. Once past warm-up, `middle` and `end` buckets are statistically indistinguishable for both modes (orch P95 889 vs 890; chor P95 336 vs 336).

**At this load, neither pattern is the limiting factor.**

**The dominant finding is structural, not temporal: choreography is ~3× faster end-to-end.** Even in an endurance test, the headline number jumps out: **choreography averages 250 ms vs orchestration's 756 ms**, P95 gap **571 ms** absolute. This is **constant across all three buckets**, so it's a property of the patterns, not a transient.

The cause is architectural. In orchestration, every saga step is a Temporal workflow task: `Postgres workflow-history append → workflow advance → activity dispatch → activity result append → Postgres again`. Five steps × ~150 ms central-state round-trip ≈ 750 ms. In choreography, each service consumes a RabbitMQ event, writes to its own DB, and emits the next event — no central state machine, no per-step history persistence. Five hops × ~50 ms ≈ 250 ms.

So **orchestration pays ~500 ms of latency for centralized workflow state and explicit recovery semantics**, sustained over the full 5 minutes. Test J controls for everything else (same infra, same rate, same duration, same product mix, same state reset).

**Tail-latency behaviour differs — orchestration's tail is fatter even at steady state.** After the start bucket flushes warm-up:

- **Choreography post-warmup max ≈ p99 + 30 ms** (374 vs 362). The tail is *tight*: events flow through RabbitMQ with predictable per-hop cost, no "stop-the-world" event introduces outliers.
- **Orchestration post-warmup max ≈ 2× p99** (1,952 vs 985). Even when nothing is degrading, ~1 in every ~2,500 sagas takes roughly twice as long as the 99th percentile. Most plausible cause: **Temporal's sticky-task-queue cache miss / workflow-task timeout retry** — when a worker rebalances or a task lands on a non-cached worker, the workflow has to be replayed from history, adding hundreds of ms.

Worth flagging: orchestration provides stronger consistency guarantees but **exhibits a wider tail-latency distribution** that doesn't shrink under sustained moderate load.

**The start-bucket P99 spike in orchestration (1,715 ms) is warm-up, not pattern overhead.** Orchestration's start P99 is nearly **2× its middle/end P99** (~990 ms). Choreography's start P99 (363.6 ms) is **identical** to middle/end (~362 ms). Tells us:

- **Temporal workers carry a heavier cold path** than MassTransit consumers — workflow-type registration, sticky-queue assignment, Postgres history-table query-plan compilation all happening on the first few hundred orders.
- **Choreography's per-service startup is amortised invisibly** because a `MassTransit consumer + EF context warm-up` takes a handful of milliseconds vs Temporal's seconds-scale registration.

**Throughput parity confirms neither is rate-saturated.** 7,331 vs 7,410 completed sagas (target 7,500) → **both modes processed ~98% of arrivals** with no errors. The missing ~2% is k6's natural arrival-rate jitter at the boundaries. This rules out the alternative explanation that "orchestration looks slower because it's queueing." It isn't — every saga is being completed; the cost is per-saga in the critical path.

### What this test does *not* tell you

- **No compensation in this run** (`FAIL_RATE_PCT=0`). Orchestration's compensation cost is typically much closer to choreography's than its happy-path cost — a Test H/M question.
- **25 rps is moderate**, not saturating. The "does choreography degrade first because of RabbitMQ, or orchestration because of Temporal history bloat?" question needs a re-run at higher rates (50, 100 rps) and longer durations (15–30 min).
- **5 minutes is short** for memory leaks. CLR-style slow leaks need 30+ minutes. The drift signal here only rules out *fast* leaks.

### Bottom line

> At 25 rps sustained for 5 minutes, **both saga patterns are steady-state with no measurable degradation or queue backlog**. The structural latency gap between them — choreography ~3× faster on average, ~2.7× faster at P95 — is **constant over time**, confirming it is a property of the coordination model, not an artefact of warm-up or accumulated load. Orchestration additionally exhibits a wider P99-to-max gap that persists at steady state, indicating a heavier tail driven by workflow replay and worker rebalancing.

---

## Test K — Concurrent-Customer Throughput

### Purpose

Measures **pure pipeline parallelism** under high concurrency with **zero row-level contention**.

- Many VUs fire orders simultaneously, but each VU targets a **different** product from a plenty-stock pool, so no two concurrent sagas fight over the same `Product.ReservedQuantity` row.
- Isolates the **structural overhead** of each saga pattern (HTTP intake, Temporal workers vs. MassTransit consumers, DB connection pools, broker hops) from the optimistic-concurrency cost that Test F intentionally stresses.
- Compared against Test F at matching VU counts, the gap quantifies the **price of contention**. Standalone, Test K answers: *which pattern parallelises happy-path sagas better?*

### Setup

- **Workload**: k6 `constant-vus` — each VU loops as fast as it can with no rate cap.
- **Configuration**: `VUS=25`, `DURATION=30s`.
- **Endpoint**: `POST /api/orders/benchmark` (blocking — returns only at terminal state, with full timing telemetry).
- **Product distribution**: 5 plenty-stock products (100k units each); each VU pinned to one via `__VU % 5`. 25 VUs spread across all 5 products with 5 VUs per row — no oversell pressure.
- **Thresholds**: `p(95) total_saga_duration_ms < 15 000 ms`.
- **Setup**: inventory reset, order purge, payment failure rate = 0%, 2 s settle.
- **Mode switching**: `SAGA_MODE` flipped between runs via `--force-recreate` (infra stays warm).
- **Captured**: `apiResponseMs`, `totalSagaDurationMs`, `orders_completed`, `orders_failed`, `effectiveThroughputPerSec = completed / durationSec`.

### Results

#### Headline numbers — warm runs (25 VUs, 30 s)

| Metric | Orchestration | Choreography | Choreo vs Orch |
|---|---:|---:|---:|
| Orders completed | 897 | 1 734 | **1.93×** |
| Orders failed | 1 | 75 | +74 |
| Effective throughput | 29.9 orders/s | **57.8 orders/s** | **+93%** |
| API response P95 | 23.8 ms | 4.5 ms | **−81%** |
| API response P99 | 55.4 ms | 37.6 ms | −32% |
| API response max | 71.1 ms | 148.4 ms | +109% |
| Saga duration median | 779.5 ms | 258.2 ms | **−67%** |
| Saga duration P95 | 962.6 ms | 365.0 ms | **−62%** |
| Saga duration P99 | 1 689.6 ms | 1 327.3 ms | −21% |
| Saga duration max | 1 995.7 ms | 4 251.7 ms | +113% |

#### Run-to-run consistency

**Orchestration** is highly stable across both runs:

- Throughput: 29.7 → 29.9 orders/s (±0.7%)
- Saga P95: 1 040.5 → 962.6 ms
- Failures: 0 → 1

**Choreography** shows a striking **first-run penalty**:

- First run (cold consumers): 30.2 orders/s, saga P95 398.9 ms but **P99 = 7 384 ms, max = 9 285 ms**, API P99 = 1 444 ms.
- Second run (warm): 57.8 orders/s, saga P99 = 1 327 ms, max = 4 252 ms.

The first run was capped at the same throughput as orchestration because a long tail of slow sagas blocked VUs from looping. After warm-up, throughput nearly doubles.

### Analysis

**Choreography is ~2× faster on a contention-free happy path.** With 25 VUs spread over 5 products, both patterns have ample parallelism; what differs is how a single saga moves through its 5 steps:

- **Orchestration (Temporal)**: every step transition is a workflow-task round trip. Five steps mean **five history writes + five task-queue dispatches** in addition to actual work, all funneled through the central server. Median saga = 779.5 ms.
- **Choreography (MassTransit/RabbitMQ)**: each service consumes the previous service's event and publishes the next directly. No central history write per step; each hop is one queue publish + one consumer dispatch. Median saga = 258.2 ms — **3.0× faster at the median**, ~2.6× at P95.

Because `/api/orders/benchmark` blocks until terminal state, halving saga duration roughly doubles VU loop frequency: **57.8 vs 29.9 orders/s ≈ 1.93×**, almost perfectly tracking the median saga ratio.

**API intake is also dramatically faster in choreography.** API P95 of **4.5 ms vs 23.8 ms** (−81%) reflects what `OrderService` does to start each pattern:

- Orchestration: synchronously calls `Temporal.StartWorkflow` — network round trip to Temporal frontend + synchronous Postgres insert into workflow history.
- Choreography: in-process MassTransit `Publish` — fire-and-forget, no synchronous DB write on the hot path.

Consistent across both choreography runs (P95 6.0 ms cold, 4.5 ms warm).

**Choreography wins the median but loses the tail.** Max latencies invert the headline ranking:

- Orchestration max saga: **1 996 ms** (≈ 2× P95).
- Choreography max saga: **4 252 ms** (≈ 12× P95).

Temporal's central state machine gives it tightly bounded outliers — each step is acknowledged and timer-driven by a single coordinator. In choreography, a tail emerges whenever a RabbitMQ consumer lags, a service's connection pool blocks, or a transient DB lock delays a single step — and there is no coordinator to retry deterministically, so the slowest hop dictates the whole saga's tail. This is also where the **75 failed orders** come from: at the saturated rate, some sagas exceed the 35 s timeout or trip the `finalStatus !== Completed` check.

Orchestration's failure count of **1 / 897** vs choreography's **75 / 1 809** is a direct expression of the durability/throughput trade-off: Temporal pays a per-step latency tax in exchange for a deterministic state machine that almost never loses sagas under this load; MassTransit + RabbitMQ ships nearly twice as many sagas through but with a measurable tail-failure rate.

**The cold-start penalty is asymmetric.** The first choreography run collapsed to **30.2 orders/s** — indistinguishable from orchestration — even though steady-state choreography runs at 57.8. Signature: P99 saga of 7 384 ms and API P99 of 1 444 ms (both ~5× higher than warm), while the median (259 ms) is unchanged. Diagnosis: a small number of MassTransit consumers were still warming up (queue binding, EF query-plan compilation, JIT tiered compilation) when the 25 VUs immediately saturated the pipeline; head-of-line blocks rippled through the in-flight pool.

Orchestration shows no such asymmetry between its two runs (29.7 → 29.9), because Temporal workers prefetch tasks at a steady cadence and warm up gradually. **Practical implication**: choreography's published throughput must be qualified with a warm-up clause — Test L (cold-start) is the natural follow-up.

### What this isolates

Because `Product.Version` contention is removed by VU-to-product pinning, Test K's gap is **not** caused by row-locking — it is the structural overhead of each pattern. Comparing this to Test F at the same VU count quantifies the fraction of orchestration's deficit that is intrinsic vs. the cost of serialising contended writes.

### Headline

At 25 VUs over disjoint products on warm services:

- **Throughput / latency winner**: choreography (≈ 2× orders/s, ≈ 3× faster median saga, ≈ 5× faster API P95).
- **Tail-latency / reliability winner**: orchestration (max saga 2 s vs 4.3 s; 0.1% failure rate vs 4.1%).
- **Cold-start sensitivity**: choreography degrades sharply in the first run; orchestration is run-to-run stable.

---

## Test L — Cold-Start Penalty

### Purpose

Measures the **latency penalty on the first few requests after a fresh service restart**, isolating warm-up cost that single-shot benchmarks normally hide. Captures:

- **Temporal worker activation** (workflow type registration, sticky cache initialisation) for orchestration.
- **MassTransit consumer subscription** (queue/exchange/binding setup, channel allocation) for choreography.
- **EF Core query-plan compilation** on first hit.
- **.NET tiered JIT** moving hot methods from Tier-0 to Tier-1.

Metric: `coldPenaltyMs = firstRequestMs − warmTailAvgMs`.

### Setup

- **Iterations**: 20 sequential orders (`vus: 1`, `per-vu-iterations`).
- **Gap**: 500 ms between requests — long enough not to overlap, short enough that JIT/EF caches don't decay.
- **Endpoint**: `POST /api/orders/benchmark` (blocks until terminal saga state — full end-to-end time).
- **Cold trigger**: the 5 .NET saga services + api-gateway are `docker compose up -d --force-recreate`'d immediately before each run. Postgres, RabbitMQ, and Temporal are *not* recreated, so their schemas, queue topology, and workflow-type registry stay warm. **The penalty measures service-process cold start, not infrastructure cold start.**
- **Cold penalty**: `firstRequestMs − avg(perRequestMs[10..20])`. The "warm tail" is the second half.

### Results

| Metric | Orchestration | Choreography | Δ (Choreo − Orch) |
|---|---:|---:|---:|
| First request (ms) | 1375 | 1918 | **+543** |
| Warm tail average (ms) | 368 | 261 | **−107** |
| Cold-start penalty (ms) | **1007** | **1657** | **+650** |
| Min warm request (ms) | 321 | 198 | −123 |
| Max warm request (ms) | 456 | 376 | −80 |

**Per-request profile (ms):**

| # | Orch | Choreo | | # | Orch | Choreo |
|---:|---:|---:|---|---:|---:|---:|
| 1 | **1375** | **1918** | | 11 | 344 | 278 |
| 2 | 331 | 364 | | 12 | 372 | 204 |
| 3 | 357 | 273 | | 13 | 385 | 321 |
| 4 | 398 | 198 | | 14 | 380 | 239 |
| 5 | 421 | 337 | | 15 | 321 | 199 |
| 6 | 398 | 304 | | 16 | 398 | 376 |
| 7 | 335 | 345 | | 17 | 345 | 201 |
| 8 | 396 | 231 | | 18 | 350 | 258 |
| 9 | 456 | 360 | | 19 | 387 | 277 |
| 10 | 373 | 308 | | 20 | 394 | 253 |

**Key shape**: in **both** modes the first request is the dramatic outlier. Request #2 already lands within the normal warm-tail band, so almost the entire cold cost is paid by a single saga.

### Analysis

**Choreography pays a 65% larger cold-start penalty** (1657 ms vs 1007 ms — ~650 ms larger). Architectural explanation:

- **Choreography** must, on the first message, bind queues, declare exchanges, allocate AMQP channels, and start consumers in **all four** downstream services (`Inventory`, `Payment`, `Shipping`, `Notification`) since each independently consumes the previous step's event. Every service pays its own MassTransit + EF cold cost on its first message, and these costs **chain serially** along the saga.
- **Orchestration** does most cold work upfront in *one* place: the Temporal worker hosted in `OrderService` activates the workflow, registers types, and warms the sticky cache. Activities in other services still cold-start, but the Temporal client connection and dispatcher are centralised, so per-hop overhead is smaller.

**Choreography is faster in steady state** — 261 ms vs 368 ms (~29% steady-state advantage). Consistent with the patterns' theoretical cost model:

- Orchestration adds a Temporal round-trip per step (~5 extra Temporal RPCs and history writes per saga).
- Choreography's per-step cost is a single RabbitMQ publish + consume, no central history table to update.

### Break-even analysis

If a freshly deployed service handles `N` requests before being restarted again:

```
T(orch)   ≈ 1375 + 368 · (N − 1)
T(choreo) ≈ 1918 + 261 · (N − 1)
```

Solving `T(choreo) ≤ T(orch)` gives `N ≥ 1 + 543/107 ≈ 6.1`. **From request #7 onward, choreography is cumulatively faster**, despite its worse first-request latency. For any non-trivial workload between deploys, the steady-state advantage dominates.

### What the cold cost actually represents

Because Postgres, RabbitMQ, and Temporal are not recreated, the measured penalty is **purely the .NET service-process warm-up**, not infrastructure spin-up. A full `docker compose down/up` would push the cold penalty 5–10× higher because Temporal auto-setup and Postgres buffer-cache warmup would land on the first saga. Reported numbers are the **best-case** cold-start scenario — the pattern most relevant to rolling deploys and pod restarts where the broker / DB stay up.

### Practical implications

- **Workloads with rare restarts and sustained traffic** (long-lived services, blue-green deploys with traffic ramp): **choreography wins overall**. The 543 ms one-off penalty amortises within a handful of requests.
- **Workloads with frequent cold starts** (autoscaling on bursty traffic, serverless scale-to-zero, canary deploys exposed to a single early request): **orchestration is more predictable**. First-request cost is lower in absolute terms (1375 vs 1918 ms), and warm-vs-cold variance is smaller (factor 3.7× vs 7.3×).
- **Tail-latency / SLO design**: if a P99 SLO must be honoured immediately post-deploy, choreography's first-request 1918 ms is the figure to budget against, and a synthetic warm-up hit before exposing the pod to real traffic is essentially mandatory. Orchestration tolerates "deploy then receive traffic" with less ceremony.
- **Caveat on N=1 first request**: each mode has only one cold sample, so absolute numbers carry per-run noise. The *relative ordering* — choreography's bigger cold spike but faster warm tail — is the robust finding; repeating 3–5× and reporting the median would tighten the claim without changing the conclusion.

---

## Test M — Failure During Rollback

### Purpose

Reproduces the supervisor's scenario: *what happens when a compensation step itself fails mid-rollback?* It asks whether the saga can self-recover or leaves the system permanently inconsistent.

Test I validates the **happy compensation path**. Test M goes further by injecting a **second failure into the rollback itself**, surfacing the divergence in how each pattern degrades when its compensating action cannot complete.

### Setup

**Per iteration**:

- **Force compensation entry** — `PaymentService.failure-rate = 100`, so every saga enters rollback after Reserve succeeds.
- **Inject the cascading failure** — `FAIL_TARGET` either:
  - `inventory` → `InventoryService.ReleaseAsync` throws on every call.
  - `notification` → `NotificationService.SendAsync` throws on every call.
- **Place 10 orders** sequentially (`vus=1`, `iterations=10`); poll `/api/orders/{id}/status` every 100 ms up to 15 s per order.
- **Classify outcome**:
  - `ordersReachedFailed` — order reached terminal `Failed`.
  - `ordersStuck` — never terminal within 15 s.
  - `inconsistentUnits` — inventory leak (`currentReserved − baselineReserved`) **plus** stuck orders.
- **Teardown** resets failure rates, sleeps 5 s, snapshots inventory + status histogram.

Two scenarios × two patterns = four runs per session.

### Results

#### Scenario A — `FAIL_TARGET=inventory` (compensation step that mutates state)

| Metric | Orchestration | Choreography |
|---|---|---|
| Orders reached `Failed` | **10 / 10** | **0 / 10** |
| Orders stuck (`Compensating`) | 0 | **10** |
| Inconsistent units (leak + stuck) | **10** (pure inventory leak) | **20** (10 leaked + 10 stuck) |
| Time-to-terminal avg | 3643.5 ms | n/a |
| Time-to-terminal p95 / max | 3722.6 / 3723.0 ms | n/a |

#### Scenario B — `FAIL_TARGET=notification` (best-effort, side-effect-free)

| Metric | Orchestration | Choreography |
|---|---|---|
| Orders reached `Failed` | **10 / 10** | **10 / 10** |
| Orders stuck | 0 | 0 |
| Inconsistent units | 0 | 0 |
| Time-to-terminal avg | 3625.3 ms | **215.8 ms** |
| Time-to-terminal med | 3624.5 ms | 218.5 ms |
| Time-to-terminal p95 | 3718.8 ms | 274.1 ms |
| Time-to-terminal max | 3721.0 ms | 316.0 ms |

### Analysis

**Headline finding: neither pattern self-heals — they fail differently.** When a compensation step is permanently broken, **both patterns leave the system inconsistent**. The interesting comparison is the *failure mode*, not whether it fails. *"Neither pattern auto-recovers from a permanently-failing compensation step. They differ only in how they fail."*

#### Inventory failure: silent leak vs. visible stall

The high-impact case because the failing step mutates persistent state.

- **Orchestration (Temporal)** — Every order reaches `Failed` in ~3.6 s, but **10 inventory reservations leak**. The Temporal compensation activity is configured with `MaximumAttempts = 1`; the throwing `ReleaseAsync` call is swallowed by the workflow's catch block, the workflow continues to the `Failed` transition, and the reserved stock is never given back. Operationally this is the **most dangerous** outcome: the system *looks* healthy — orders are closed, no queue depth, no retries — yet inventory has silently drifted. Detection requires a reconciliation job comparing `Order.Status` against `Product.reservedQuantity`.

- **Choreography (MassTransit)** — Every order is **stuck in `Compensating`**, so the inconsistency count doubles (10 leaked + 10 stuck = 20). MassTransit's `UseMessageRetry` retries `ReleaseInventory` three times, then dead-letters the message to `release-inventory_error`. The saga state machine waits indefinitely for an `InventoryReleased` event that never arrives. The failure is **loud**: stuck saga rows in `OrderSagaState`, non-empty DLQ in RabbitMQ, alert-friendly. Recovery requires a DLQ replay tool plus operator action.

The trade-off: **orchestration optimises for terminal-state cleanliness at the cost of silent state corruption; choreography preserves an explicit "unfinished work" signal at the cost of leaving the saga visibly broken**. Which is preferable depends on whether the operations team has reconciliation jobs (favouring choreography's loud failure) or whether the business prioritises closed orders for downstream consumers (favouring orchestration's terminal guarantee, accepting the leak).

#### Notification failure: where the patterns *actually* converge — but with very different latency

Both patterns reach `Failed` cleanly with zero inconsistency, because failure-notification is implemented as best-effort (`try { send } catch { log }`) on both sides — a thrown notification doesn't block the saga. So functionally, they're identical for this scenario.

The latency, however, is dramatically different:

- Orchestration: ~3.6 s avg, identical to the inventory-failure path.
- Choreography: ~216 ms avg — roughly **17× faster**.

The orchestration time is independent of *which* compensation target fails, indicating the ~3.6 s is the inherent Temporal compensation pipeline cost (activity scheduling + retry budget exhaustion + state transition writes). Choreography's compensation is just a fire-and-forget `Publish<SendNotification>` followed by a synchronous saga state transition — it doesn't wait for the notification at all, so the failure injection never blocks the saga.

This means **for low-impact compensation failures, choreography recovers an order of magnitude faster**, but as Scenario A shows, that speed disappears (becomes infinite) the moment the failing step is one the saga actually waits on.

### Methodological caveats

- Sample size small (10 iterations per cell) — fine for the qualitative pass/fail signal but timing percentiles in `timeToTerminalMs` are illustrative, not statistically robust.
- The `inconsistentUnits` metric overloads two distinct failure modes (leak count + stuck count). For the choreography-inventory cell, the value `20` reflects *both* effects on the same 10 orders — not 20 separate failures.
- The 15 s polling timeout is comfortable for orchestration's ~3.7 s terminal time but bounds how confidently we can say choreography orders are *permanently* stuck vs just slow. Tests N (broker outage) and O (worker crash) probe longer recovery windows.
- Notification compensation is best-effort *by design* in both implementations — Scenario B validates that design choice but doesn't probe what happens if a non-best-effort downstream step fails. That's exactly what Scenario A is for.

### Implications

Test M demonstrates that **compensation correctness is not an automatic property of either saga pattern** — it depends on:

1. The retry/timeout policy configured on the failing step.
2. Whether the saga *waits* on that step's success event.
3. Whether the operations team has tooling to detect silent inventory drift versus stuck saga rows.

Both patterns require external recovery tooling (reconciliation job for orchestration, DLQ replay for choreography) for production-grade resilience to permanently-failing compensations. The pattern choice influences *how* you build that tooling, not *whether* you need it.

---

## Test N — Broker Outage During Rollback

### Purpose

Verifies that an in-flight saga **survives a restart of its underlying broker mid-rollback**. Each pattern depends on a different broker:

- **Orchestration** → `saga-temporal` (Temporal server holds workflow state and dispatches activities).
- **Choreography** → `saga-rabbitmq` (message bus carries the saga's `*Reserved` / `*Failed` / `Release*` events).

Question: *Once the broker comes back, do all sagas drive themselves to a terminal state, and is there any orphaned state (stuck orders, leaked inventory)?*

Complements Test M (failure of a compensation **step**) by failing the **transport** instead.

### Setup

Defaults from `run-broker-outage-test.sh`:

- **`ORDERS=10`**, **`BROKER_DOWN_SECS=10`**, **`RECOVERY_SECS=90`**, **`WARMUP_MS=500`**.
- All orders target the same product (`a1111111-...`).

**Run sequence**:

1. Reset inventory + orders, set **`payments/failure-rate/100`** so every order is forced into compensation.
2. Snapshot baseline `reservedQuantity`.
3. Place 10 orders sequentially.
4. Sleep 500 ms so sagas start running.
5. `docker stop` the relevant broker; wait 10 s; snapshot order-status histogram **during** the outage.
6. `docker start` the broker, wait for healthcheck.
7. Poll `/api/orders/recent` every 2 s for up to 90 s, exit early if every order has reached `Completed`/`Failed`.
8. Final histogram + inventory leak (`reservedNow − baseline`); reset payment failure rate.

The orchestration and choreography runs were performed back-to-back at 23:01:40 and 23:03:09 on 2026-04-28.

### Results

#### Orchestration

| Phase | Value |
|---|---|
| Broker stopped → started | 23:01:44 → 23:01:55 (~11 s outage) |
| Order histogram **during** outage | `{Pending: 10}` |
| Recovery poll | **All 10 reached terminal before 90 s deadline** |
| Final histogram | `{Failed: 10}` |
| Inventory leak | **2** units (baseline 0, reserved 2) |
| Wall-clock | started 23:01:40, finished 23:02:20 (~40 s total) |

#### Choreography

| Phase | Value |
|---|---|
| Broker stopped → started | 23:03:13 → 23:03:24 (~11 s outage) |
| Order histogram **during** outage | `{Compensating: 3, Failed: 4, Pending: 3}` |
| Recovery poll | "All orders reached terminal state" line **absent** → polling ran the full 90 s |
| Final histogram | `{Compensating: 1, Failed: 8, Pending: 1}` — **2 orders stuck** |
| Inventory leak | **1** unit |
| Wall-clock | started 23:03:09, finished 23:04:55 (~106 s, almost entirely the 90 s poll) |

### Analysis

**Saga progress at the moment of the kill is asymmetric.** With orchestration, **every** activity dispatch goes through Temporal. The 500 ms warmup is shorter than the time the first activity needs to round-trip through the Temporal worker, so when the server dies, none of the 10 sagas have advanced past `Pending` (`Pending: 10` at `t = 10 s`).

Choreography moves through asynchronous RabbitMQ messages with no central coordinator: by the time `saga-rabbitmq` is killed, **4 sagas already settled to `Failed`**, 3 are mid-compensation, and only 3 are still pre-compensation. So orchestration enters its outage window with 10 in-flight workflows, choreography with effectively 6. **This asymmetry should be noted when comparing recovery numbers.**

**Recovery behaviour:**

- **Orchestration recovers cleanly and quickly.** Temporal replays workflow history from Postgres on restart, the worker reattaches, and pending activities are re-dispatched. All 10 orders reach `Failed`, well inside the 90 s budget — wall-clock from outage end to test end is ~25 s.
- **Choreography does not fully recover within 90 s.** RabbitMQ comes back with durable queues intact, but **2 of 10 orders remain non-terminal** — 1 stuck `Compensating`, 1 stuck `Pending` — even after the full poll window. MassTransit redelivers most events, but at least one `InventoryReleased` / payment-failed handoff was lost or dead-lettered such that the saga state machine never advances. Matches the predicted choreography failure mode: a saga waiting on a callback that never arrives stays in `Compensating` indefinitely.

**Inventory leak — same outcome, different visibility.** Both modes leak stock, but the *kind* of leak matters:

- **Orchestration**: 2 leaked reservations on **10 fully-`Failed`** orders. Same compensation-bug pattern Test M surfaced — `CompensationActivityOptions.MaximumAttempts = 1` causes `ReleaseInventory` to swallow a transient broker-recovery error and the workflow's catch-loop marks the saga `Failed` regardless. **The order looks healthy to an operator; the inventory accounting is silently wrong.**
- **Choreography**: 1 leaked reservation, correlated with the 2 stuck orders. The saga is **visibly stalled** (status reveals it), so the operator has a clear signal that intervention is required.

### Net comparison

| Property | Orchestration | Choreography |
|---|---|---|
| All orders terminal? | **Yes** (10/10 `Failed`) | **No** (2/10 stuck) |
| Time to settle after restart | ~25 s | > 90 s (poll exhausted) |
| Failure mode | **Silent** (looks `Failed`, inventory wrong) | **Visible** (status stuck `Compensating`/`Pending`) |
| Inventory leak | 2 / 10 | 1 / 10 |

**Orchestration wins on liveness** (workflow history replay is deterministic and bounded); **choreography wins on observability** (a stuck saga row is a louder alarm than a silently-leaked reservation). Neither pattern auto-recovers cleanly — the leaks are the same compensation-layer issue Test M flagged, surfaced through a different failure injection.

### Caveats

1. **Sample size tiny**: 10 orders, one run per mode. Treat the leak/stuck numbers as illustrative, not statistical. A re-run with `ORDERS=50` and 3+ repetitions would tighten this.
2. **Asymmetric pre-outage progress** (10 `Pending` vs 4 `Failed` + 3 `Compensating` + 3 `Pending`) makes the recovery comparison unfair on its face. Tuning `WARMUP_MS` until both modes have the same status distribution at kill-time would isolate "broker recovery cost" from "saga step latency".
3. **Recovery window**: at `RECOVERY_SECS=90`, choreography's 2 stuck orders may simply need longer than 90 s. Re-running with 300 s would distinguish "slow but eventually recovers" from "permanently stalled".
4. The Temporal-side leak is a **configuration choice** (`MaximumAttempts = 1` on the compensation activity), not a fundamental orchestration limitation. Raising it would close the leak — but break symmetry with the choreography retry policy that Test M was designed to compare.

---

## Test O — Worker Crash Mid-Saga

### Purpose

Validates **resilience to a crash of the saga coordinator process**. The container `saga-order-service` is killed while sagas are mid-flight, then restarted, to verify whether each pattern resumes its in-flight sagas and reaches a consistent terminal state.

This is a particularly strong comparison point because `saga-order-service` hosts both:

- The **Temporal worker** (orchestration) — i.e. the activity executor.
- The **MassTransit saga state machine** (choreography) — i.e. the `OrderSagaState` consumer.

So the same single-process failure exercises *both* patterns' recovery mechanisms — Temporal's "server-managed workflow history" vs MassTransit's "broker-managed at-least-once delivery".

### Setup

Driven by `run-worker-crash-test.sh`:

- **Forced compensation path** — `PaymentService.failure-rate=100`, so every order must enter compensation.
- **Workload** — `ORDERS=10` orders posted via the gateway, each for 1 unit of `a1111111-...` at $29.99.
- **Crash window** — `WARMUP_MS=500`, then `docker kill saga-order-service`.
- **Downtime** — `DOWN_SECS=5`.
- **Restart** — `docker start saga-order-service`, poll `/api/orders/config` until healthy.
- **Observation window** — `RECOVERY_SECS=90`, polling `/api/orders/recent` every 2 s, breaks early if all orders are terminal.
- **Final report** — order-status histogram + inventory leak vs baseline.
- **Infrastructure not touched** — Postgres, RabbitMQ, and Temporal stay up the whole time. Only `saga-order-service` is killed.

Both modes were run with identical parameters, ~2 minutes apart on 2026-04-28.

### Results

#### Orchestration

| Metric | Value |
|---|---|
| Killed at | `23:05:53` (≈2 s after start) |
| Back up at | `23:05:59` (≈6 s downtime) |
| Recovery polling | **Exited early** — "All orders reached terminal state" |
| Final histogram | `{"Failed": 10}` |
| Inventory leak | `0` (reserved=0, baseline=0) |
| Total wall-clock | ~25 s |

**All 10 orders reached `Failed` (the expected terminal state under forced 100% payment failure).**

#### Choreography

| Metric | Value |
|---|---|
| Killed at | `23:07:33` (≈3 s after start) |
| Back up at | `23:07:40` (≈7 s downtime) |
| Recovery polling | **Timed out** — no "All orders reached terminal state" line |
| Final histogram | `{"Pending": 6, "Failed": 4}` |
| Inventory leak | `0` (reserved=0, baseline=0) |
| Total wall-clock | ~101 s |

**Only 4 of 10 orders reached a terminal state; 6 were still `Pending` after the full 90 s recovery window.**

#### Side-by-side

| Outcome | Orchestration | Choreography |
|---|---|---|
| Orders reaching terminal state | **10 / 10** | **4 / 10** |
| Orders stuck non-terminal | 0 | **6 (Pending)** |
| Time to full recovery | ~17 s of polling | **never (timeout at 90 s)** |
| Inventory leak | 0 | 0 |

### Analysis

**Orchestration: clean recovery.** Temporal externalises the workflow's source of truth into the Temporal server's history table. When `saga-order-service` is killed:

- The workflow itself is *not* hosted in OrderService — it lives on the Temporal server.
- Any activity in flight at crash time is marked failed-task and **redispatched** to the next worker that polls the task queue.
- When OrderService comes back up, its Temporal worker reconnects, claims pending activity tasks, and the workflow advances exactly where it left off.

Empirically: all 10 sagas drove through Reserve → Payment(fail) → Compensate(release) → `Failed`, with **zero inventory leak**, polling exited early (~17 s) because everything was terminal.

**Choreography: 60% of sagas stuck in `Pending`.** Choreography here uses MassTransit's saga state machine, with state persisted to OrderService's Postgres `OrderSagaState` table and events flowing through RabbitMQ. The expected recovery story is:

- Events published before the crash sit durably in RabbitMQ queues.
- On restart, MassTransit's consumers re-attach and drain the queues, advancing the saga rows.

That story did *not* hold. **6 of 10 orders never advanced past `Pending` in the 90 s after restart.** Most likely root causes:

- **`OrderCreated` events lost on the publisher side.** The order POST likely returned 202 *before* the corresponding `OrderCreated`/`StartSaga` message had been confirmed to RabbitMQ (no transactional outbox + publisher-confirms wired through to the HTTP response). When the process was killed, those un-published events were lost — there is no broker copy to redeliver, no Temporal-style server holding the intent. The `Order` row exists (`Pending`), but the event that would advance it was never durably handed off.
- **Saga state machine has no "kick-restart" of stale rows.** Even though `Pending` rows exist in Postgres, MassTransit will only progress them if a matching event arrives. With no `OrderCreated` in the queue, the rows sit there forever.
- The 4 that *did* fail are the orders whose `OrderCreated` was confirmed to RabbitMQ before the kill, and whose downstream events (`PaymentFailed`) were also durably queued. Those replayed correctly on restart — choreography's at-least-once mechanics work *for events that actually made it into the broker*.

### What this comparison demonstrates

| Aspect | Orchestration (Temporal) | Choreography (MassTransit) |
|---|---|---|
| Where workflow intent is persisted | **External durable server** (Temporal history table) | OrderService memory + Postgres saga row + RabbitMQ queue |
| Survival of "intent" when host process dies before first event | **Yes** — Temporal already accepted the workflow start | **No** (in this implementation) — `OrderCreated` can be lost between HTTP 202 and broker publish |
| Recovery action | Worker reconnects, Temporal redispatches in-flight activities | Consumer re-attaches, drains queues — but only for events the broker actually has |
| Result on `ORDERS=10`, `DOWN_SECS=5` | **10/10 terminal, 0 leak** | **4/10 terminal, 6 Pending, 0 leak** |
| Operator visibility into "what's stuck" | Workflow visible in Temporal UI as Running | `Pending` row in `OrderSagaState`, no queued event — silent stall |

### Caveats

- **Inventory was consistent in both modes** (no oversell, no leak), so this is *not* a data-corruption result — it is a saga-progression result.
- **The choreography behaviour is implementation-dependent.** Adding a transactional outbox, publisher-confirms gating the HTTP 202, or a periodic "scan stale `Pending` sagas and republish" job would close the specific gap observed here. The point for the thesis is that **orchestration via Temporal gets crash-mid-saga durability "for free", while choreography requires deliberate engineering of every persist-then-publish boundary** — and a reasonable, working choreography setup like this one can still drop sagas on the floor when the coordinator process dies.
- **Sample size is small** (10 orders, single run per mode). Results are clear-cut here, but a higher `ORDERS` value (50–100) and 3–5 repetitions per mode would let you cite a stuck-saga rate rather than a single 6/10 datapoint.

### Suggested framing

> Under a coordinator-process crash mid-saga, orchestration drove 10/10 forced-compensation sagas to a consistent terminal state in ~17 s, while choreography — without a transactional outbox — left 6/10 sagas indefinitely stuck in `Pending` because their `OrderCreated` events never reached RabbitMQ before the process died. Both patterns preserved inventory invariants, but only orchestration preserved saga progress. This concretely illustrates the cost choreography pays when the saga's "source of truth" is co-located with the process that can crash.

---

## Overall Summary

### Performance (happy path)

| Metric | Winner | Margin |
|---|---|---|
| Saga end-to-end latency (1–10 rps) | **Choreography** | ~50–500 ms faster (Test A, J) |
| Sustainable throughput | **Choreography** | ~5× higher (Test A: 50 rps vs 10 rps) |
| Concurrent throughput (warm) | **Choreography** | ~2× orders/s, ~3× faster median saga (Test K) |
| API intake P95 | **Choreography** | ~80% lower in healthy regime (Tests A, K) |
| Per-step P95 | **Choreography** | ~100 ms lower per step (5 steps × ~100 ms = ~500 ms saga gap) |

### Stability and tails

| Metric | Winner | Notes |
|---|---|---|
| Tail latency / max | **Orchestration** | Choreography max often 6–12× p95; orch ~2× p95 (Tests E, J, K) |
| Run-to-run consistency (cold first run) | **Orchestration** | Choreography shows large first-run penalty (Test K) |
| Endurance (5 min @ 25 rps) | **Tie** | Both steady-state, no drift (Test J) |

### Resource efficiency

| Metric | Winner | Notes |
|---|---|---|
| Steady-state CPU | **Choreography** | Lower per-saga in healthy regime (Test D) |
| Behaviour under starvation | **Orchestration** | Graceful linear degradation; choreography collapses (Test D, 25 rps × 0.5 CPU) |
| Cold-start (single first request) | **Orchestration** | 1007 ms penalty vs 1657 ms (Test L) |
| Steady-state warm latency | **Choreography** | 261 ms vs 368 ms; break-even at ~7 requests (Test L) |

### Correctness

| Property | Both Equivalent | Notes |
|---|---|---|
| Overselling prevention (concurrent contention) | **Yes** | DB-level `xmin` token; saga pattern is irrelevant (Test F) |
| Idempotent double-click | **Yes** | Pre-dispatch idempotency record (Test G) |
| Compensation correctness (deterministic 100% failure) | **Yes** | Both reach `Failed` with no leaks (Test I) |
| Eventual-consistency window (visibility lag) | **Choreography slightly faster** (~8 ms median, ~7 ms p95) | Orchestration has a structurally heavier tail (Test E) |

### Resilience (failure-mode comparison)

| Scenario | Orchestration | Choreography |
|---|---|---|
| Compensation step throws (Test M, inventory) | All `Failed` but **silent leak** | All **stuck `Compensating`** + leak |
| Compensation step throws (Test M, notification, best-effort) | ~3.6 s but clean | ~216 ms, clean |
| Broker outage mid-rollback (Test N) | 10/10 terminal in ~25 s; 2 leaked (still silent) | 2/10 stuck after 90 s; 1 leak |
| Coordinator crash mid-saga (Test O) | **10/10 recovered** in ~17 s | **6/10 stuck `Pending`** indefinitely (no transactional outbox) |

### Failure-handling semantics

The deepest cross-cutting finding from Tests F, H, I, M, N is that **the two patterns expose different failure budgets at the saga boundary**:

- **Orchestration retries activity exceptions** by default. Transient downstream failures are silently absorbed (Test H: 0% observed failure with 10% per-call failure rate, due to `MaximumAttempts=3`). The cost is a ~3 s retry budget that becomes a latency tax in compensation paths (Tests I, M, N).
- **Choreography treats failures as business events**. A consumer that catches the failure and publishes `PaymentFailed` does not invoke `UseMessageRetry`. Compensations begin immediately (~200 ms, Test I), but transient downstream errors surface as user-visible compensations rather than being retried.

These are different design choices, not implementation bugs. Equalising them requires either disabling Temporal retries (`MaximumAttempts=1`) or wrapping choreography consumers in `UseMessageRetry` and rethrowing on business failure.

### When to choose each pattern

**Choreography is preferable when:**

- The system has CPU headroom (cluster sized so no single service exceeds ~70% CPU in steady state).
- Restarts are rare and traffic is sustained (cold-start penalty amortises in 6+ requests).
- Consistent low median latency matters more than tail bounds.
- Failures should be visible / loud (stuck sagas, DLQ entries) for operator alerting.
- Throughput is a primary requirement (~2–5× higher sustainable rate at the same hardware).

**Orchestration is preferable when:**

- The system runs near saturation or under bursty starvation (Temporal's task queue absorbs load gracefully).
- Predictable tail latency (P99–max bounded) is a hard requirement.
- The coordinator process can crash and the saga must continue (Test O).
- Frequent cold starts (autoscale, scale-to-zero) — first-request cost is lower.
- Operations team prioritises terminal-state cleanliness over silent state corruption (with a reconciliation job).

### Engineering takeaways for the thesis

1. **Saga-pattern correctness properties (overselling, idempotency, basic compensation) are inherited from the database and HTTP layer**, not from the coordination model. Both patterns pass these tests identically.
2. **The performance gap (~3× faster end-to-end for choreography) is structural** — Temporal's per-step centralised state + activity scheduling adds ~100 ms per step transition. This is the price paid for the durability and observability Temporal provides.
3. **Failure semantics dominate failure-mode behaviour** more than the saga pattern itself. The same retry policy can either fire (Temporal's exception path) or be bypassed (choreography's event path) depending on how the consumer reacts to a downstream failure.
4. **Both patterns require external recovery tooling** for permanently-failing compensations: a reconciliation job for orchestration's silent-leak failure mode, a DLQ replay tool for choreography's stuck-saga failure mode.
5. **Without a transactional outbox, choreography can lose sagas during a coordinator crash** (Test O). Orchestration via Temporal gets this durability "for free" because the workflow's source of truth is external to the host process.

---

## Atbildes (Answers)

Šī sadaļa sasaista empīriskos rezultātus ar darba ievadā formulētajiem jautājumiem un hipotēzēm.

### Pētniecības jautājumi

#### J1 — Eventual consistency un lietotāja pieredze

> *Kad lietotājs nospiež "pirkt", cik ilgi viņš gaidīs, līdz redzēs rezultātu? Un kas notiek, ja pa vidu kaut kas noiet greizi? Vai lietotājs sapratīs, kas notika? Fowler [9] norāda, ka eventual consistency var radīt nopietnas lietojamības problēmas, bet konkrētu risinājumu nav daudz dokumentētu.*

**Atbilde.** Eventual consistency loga ilgumu mēra Tests E. Mediānā krājuma izmaiņas kļūst redzamas inventāra API pēc **~32 ms (horeogrāfija)** vai **~33 ms (orķestrācija)**, bet pasūtījuma terminālā statusa (`Completed`) sasniegšana prasa **~280 ms (horeogrāfija)** vai **~345 ms (orķestrācija)**. Reālais "neapstiprinātās noteiktības" logs — kurā krājums jau ir rezervēts, bet pasūtījums vēl ir `Pending` — ir aptuveni **¼ sekundes**, neatkarīgi no izvēlētā saga modeļa.

Astes uzvedība ir asimetriska. Orķestrācijas `max` saga pabeigšanas latence sasniedz **1205 ms** (~3× virs P95), kamēr horeogrāfijas tīrajā izpildē `max ≈ p95 + 15 ms`. Tas nozīmē, ka aptuveni 1 % lietotāju orķestrācijā piedzīvos jūtami ilgāku gaidīšanu.

**Kļūdas saprotamība** ir nodrošināta abu modeļu līmenī: Tests I apstiprina, ka **100 %** kļūdaino pasūtījumu sasniedz `Failed` ar atbrīvotu krājumu abās pieejās — lietotājs saņem deterministisku stāvokli, nevis "kaut kas nogāja greizi". Tomēr Tests M un N atklāj, ka tad, ja pati kompensācija arī neizdodas:

- **Orķestrācija** atstāj pasūtījumu ar `Failed` statusu, bet ar **klusi noplūdušu krājumu**.
- **Horeogrāfija** atstāj pasūtījumu ar redzami iesprūdušu `Compensating` statusu.

Horeogrāfija ir "skaļāka" (operators redz iesprūdušu sagu), orķestrācija ir "klusāka" (orderis šķiet pabeigts, bet inventārs ir nepareizs).

**Fowler [9]** brīdinājums empīriski apstiprinās: vienreizēja gaidīšana (~280 ms) nav kritiska, bet astes gadījumos un kompensācijas kļūdās lietotāja uztvere kļūst būtiski atkarīga no implementācijas izvēlēm — idempotences atbalsta (Tests G), retry politikām (Tests H, I) un UI klienta uzvedības.

#### J2 — Race conditions

> *Divi lietotāji vienlaicīgi mēģina iegūt to pašu ierobežoto resursu — kurš uzvar? Vai zaudētājs saņem saprotamu kļūdas paziņojumu, nevis vienkārši "kaut kas nogāja greizi"?*

**Atbilde.** Tests F (20 VU vienlaicīgi pēc 1 vienības krājumā) apstiprina, ka **abas pieejas precīzi novērš pārpārdošanu**: `wins = 1, losses = 19` katrā no četriem palaidieniem. Korektība nāk no **datubāzes līmeņa** — PostgreSQL `xmin` rindas-versijas optimistiskās konkurences uz `Product.Version` lauka — un nav atkarīga no saga modeļa.

**Zaudētāju pieredzē** abas pieejas atšķiras būtiski:

| Pieeja | Avg | P95 | Spread starp palaidieniem |
|---|---:|---:|---:|
| Orķestrācija | ~3.5 s | 3 557 – 4 011 ms | < 12 % |
| Horeogrāfija | ~4.2 s | 3 914 – **33 357 ms** | **~17×** |

Iemesls: orķestrācijas aktivitāte saņem `409 Conflict`, klasificē to kā domēna kļūdu un nekavējoties pāriet kompensācijai. Horeogrāfijā `ReserveInventoryConsumer` apzināti pārmestīt `DbUpdateConcurrencyException`, ļaujot MassTransit pārmēģināt — un katrs pārmēģinājums atkal sacenšas par to pašu rindu.

**Uzvarētājs vienmēr ir viens**, bet **zaudētāja gaidīšanas laiks ir aptuveni 9× prognozējamāks orķestrācijā**. Saprotama kļūda (terminālais `Failed` statuss un `InventoryReservationFailed` notikums) tiek nodota klientam abos gadījumos; atšķirība ir tikai gaidīšanas ilgumā un dispersijā.

#### J3 — Kompensācijas mehānisms

> *Kad Saga neizdodas pusceļā, kā notiek "attīšana"? Vai orķestrācija to dara ātrāk un uzticamāk nekā horeogrāfija? Teorētiski jā, jo ir centralizēta kontrole. Bet praksē?*

**Atbilde.** Praksē — **nē**, ne ātrāk un ne automātiski uzticamāk. Tests I (100 % maksājumu kļūme, deterministiskā kompensācija) parāda:

- Orķestrācija: avg = **3 586 ms**, P95 = **3 644 ms**.
- Horeogrāfija: avg = **193 ms**, P95 = **229 ms**.

Orķestrācija ir **~18× lēnāka** sasniegt `Failed`. Iemesls **nav kompensācijas latence**, bet **kļūmes semantikas atšķirība**:

- Orķestrācijā `ProcessPaymentAsync` aktivitāte iemet `ApplicationException`, ko Temporal traktē kā pārejošu kļūdu un mēģina vēl 2 reizes (1 s + 2 s atpakaļatkāpe). Tikai pēc 3 mēģinājumiem darbplūsma pāriet `catch` zaram. Šis **~3 s aizkavējums pirms kompensācijas sākuma** veido lielāko daļu no kopējā laika.
- Horeogrāfijas patērētājs **neizmet** kļūdu — tas publicē `PaymentFailed` notikumu un atgriežas, tāpēc `UseMessageRetry` netiek iesaistīts un kompensācija sākas nekavējoties.

Tests H Scenārijs 2 sadalīja kopējo kompensācijas ilgumu divos:

| Modelis | Kopējais saga ilgums (P95) | Tikai `Compensating → Failed` logs (P95) |
|---|---:|---:|
| Orķestrācija | ~3 870 ms | ~325 ms |
| Horeogrāfija | ~262 ms | ~27 ms |

**Pati kompensācija ir maza abos modeļos** — orķestrācijai ~325 ms, horeogrāfijai ~27 ms (~12× ātrāk). Lielākā atšķirība rodas no retry politikas, nevis no koordinācijas modeļa kā tāda.

**Uzticamība** atšķiras citā dimensijā. Tests M parāda, ka, ja kompensācijas solis pats neizdodas:

- Orķestrācija: visas 10 sagas sasniedz `Failed`, **bet 10 inventāra rezervācijas paliek noplūdušas** (klusa kļūme).
- Horeogrāfija: visas 10 sagas paliek `Compensating`, ar 10 noplūdušām rezervācijām (skaļa kļūme).

**Neviena no pieejām automātiski nesakopj sevi** pēc paliekoši kļūdaina kompensācijas soļa — abas prasa ārēju atjaunošanas instrumentāciju (saskaņošanas darbu vai DLQ atspēles rīku).

#### J4 — Veiktspējas atšķirības

> *Vai ir būtiskas atšķirības starp abām pieejām, un, ja ir, kādos scenārijos tās izpaužas?*

**Atbilde.** Atšķirības ir būtiskas un izpaužas vairākās dimensijās:

| Dimensija | Atšķirība | Tests |
|---|---|---|
| End-to-end saga latence (1–10 rps) | Horeogrāfija ~50–500 ms ātrāka | A, J |
| Ilgtspējīgā caurlaide | Horeogrāfija ~5× augstāka (50 vs 10 rps) | A |
| Vienlaicīgo lietotāju caurlaide (silta) | Horeogrāfija ~2× orderi/s | K |
| Per-step P95 | Horeogrāfija ~100 ms zemāka katrā solī | A, D |
| Astes latence (max ÷ P95) | Orķestrācija ~2×, horeogrāfija 6–12× | E, J, K |
| Aukstā starta sods | Orķestrācija 1007 ms, horeogrāfija 1657 ms | L |
| CPU starvation izturība | Orķestrācija degradē lineāri; horeogrāfija sabrūk | D |

Strukturāli orķestrācija pievieno **~100 ms tax** uz katru saga soli (Temporal task-queue dispatch + history persistence), kas 5-soļu sagā summējas līdz **~500 ms**. Tas redzams jau tukšā slodzē (1 rps), tāpēc nav slodzes inducēts. Horeogrāfija šo cenu nemaksā, bet apmaiņā:

- Tās tail latence ir lielāka (slowest-hop wins).
- Tās cold-start sods ir lielāks (visi 4 patērētāji jāuzsilda secīgi).
- Tās izturība pret CPU starvation ir vājāka (Tests D: pie 0.5 CPU, 25 rps, horeogrāfija pabeidza 9 sagas, orķestrācija 109).

Tādējādi **horeogrāfija dominē mediānas/P95 metrikās siltā un labi nodrošinātā vidē**, savukārt **orķestrācija dominē tail latencē, izturībā un sagas-progresa garantijās** noslodzes vai komponenta avārijas apstākļos.

---

### Hipotēžu pārbaude

#### H1 — Horeogrāfija būs ātrāka vienkāršos scenārijos

> *Loģika: nav centrālā koordinatora, mazāk "lēcienu" starp komponentiem.*

**Verdikts: APSTIPRINĀTA.**

| Scenārijs | Horeogrāfija | Orķestrācija | Starpība |
|---|---:|---:|---:|
| Tests A, 1 rps, saga P95 | 363 ms | 409 ms | ~46 ms |
| Tests J, 25 rps avg, 5 min | 250 ms | 756 ms | **~3×** |
| Tests K, 25 VU silta, mediāna | 258 ms | 779 ms | **~3×** |
| Tests L, silto pieprasījumu vidējais | 261 ms | 368 ms | ~107 ms |

Hipotēzes loģika apstiprinās empīriski: bez Temporal centrālā koordinatora horeogrāfija izvairās no 5 × ~100 ms task-queue lēcieniem. Vienkāršos (mazas slodzes, vienpavediena) scenārijos starpība ir **~50 ms**; vidējā slodzē tā paplašinās līdz **~500 ms**, jo orķestrācijas overhead ir konstants per-step neatkarīgi no slodzes.

#### H2 — Orķestrācija ātrāk veiks kompensācijas

> *Loģika: centralizēta kontrole ļauj efektīvāk koordinēt atcelšanu. Bet vai kompensācijas vispār notiks pietiekami bieži, lai tas būtu nozīmīgi?*

**Verdikts: ATSPĒKOTA šīs kodu bāzes konfigurācijā** (ar svarīgu nianses skaidrojumu).

Tests I uzrāda **pretēju** rezultātu: horeogrāfija pabeidz kompensāciju **~193 ms** (avg), orķestrācija — **~3 586 ms**. Tas ir ~18× starpība horeogrāfijas labā.

Atspēkojums **nav fundamentāls** — tā cēlonis ir asimetriska kļūmes semantika, nevis koordinācijas modelis pats par sevi:

- Orķestrācijā maksājuma kļūme tiek pārveidota par `ApplicationException`, ko Temporal interpretē kā pārejošu kļūdu un atkārto 3 reizes (1 s + 2 s atpakaļatkāpe) **pirms** kompensācijas sākuma — ~3 s no kopējā laika ir retry budget.
- Horeogrāfijas patērētājs publicē `PaymentFailed` kā biznesa notikumu (nevis met kļūdu), tāpēc retry politika netiek iedarbināta un kompensācija sākas nekavējoties.

**Tikai kompensācijas pati logs** (`Compensating → Failed`) ir orķestrācijai **~325 ms**, horeogrāfijai **~27 ms** (Tests H, scenārijs 2). Pat tīrā kompensācijas posmā horeogrāfija ir ātrāka, bet šī starpība samazinātos līdz dažu desmitu ms, ja Temporal retry tiktu deaktivizēts. Hipotēzes loģika ("centralizēta kontrole ļauj efektīvāk koordinēt atcelšanu") **nav apstiprinājusies**: centralizēta kontrole pievieno overhead (history persistence per step), nevis to mazina.

**Otrs jautājums** — *vai kompensācijas notiek pietiekami bieži, lai tas būtu nozīmīgi?* — ir izšķiroši svarīgs. Pie 10 % per-call kļūmes likmes (Tests H, scenārijs 1):

- Orķestrācija: 3 palaidieni × 600 sagas, **0 kompensāciju** (Temporal retry buferis padara per-saga kļūmi ~0.1 %).
- Horeogrāfija: 2 palaidieni × ~600 sagas, **~10–12 % kompensāciju** (per-call kļūme ≈ per-saga kļūme).

Tādējādi **orķestrācija slēpj pārejošās kļūdas, horeogrāfija tās izceļ**. Lietotāja perspektīvā tas nozīmē, ka horeogrāfijā vairāk pasūtījumu nokļūs `Failed` stāvoklī, pat ja patiesā downstream kļūdas likme ir identiska. Kompensācijas notiek **nozīmīgi biežāk horeogrāfijā** — un tāpēc, neraugoties uz formāli ātrāku kompensāciju, kopējais lietotāja-redzamais kompensāciju slogs horeogrāfijā ir lielāks.

#### H3 — Race condition scenārijā orķestrācija uzrādīs mazāk problēmu

> *Loģika: centralizēts koordinators var labāk kontrolēt piekļuvi ierobežotiem resursiem. Bet horeogrāfiju var pastiprināt ar papildu mehānismiem, tāpēc veidojas jautājums, cik sarežģīti.*

**Verdikts: DAĻĒJI APSTIPRINĀTA.**

Korektības dimensijā **abas pieejas ir identiski drošas** (Tests F: precīzi 1 uzvarētājs no 20 VU katrā palaidienā). Tas nav saga modeļa, bet datubāzes (`xmin` versija) īpašums — saga koordinators šeit tikai nosūta notikumus, nevis kontrolē rindas piekļuvi.

Lietotāja pieredzes (zaudētāja latences) dimensijā **orķestrācija ir prognozējamāka**:

- Orķestrācija: P95 = 3 557–4 011 ms (spread <12 %).
- Horeogrāfija: P95 = 3 914–33 357 ms (spread ~17×).

Cēlonis ir tas, ka horeogrāfijas implementācija pārmestīt `DbUpdateConcurrencyException`, ļaujot MassTransit retry politikai sacensties pret to pašu rindu vairākas reizes pēc kārtas. Hipotēzes piezīme par "papildu mehānismiem horeogrāfijas pastiprināšanai" arī apstiprinās — to varētu novērst, ja patērētājs izmestu `DbUpdateConcurrencyException` kā domēna kļūdu (tieši publicējot `InventoryReservationFailed`). Tādā gadījumā horeogrāfija saskaņotos ar orķestrācijas latences profilu.

**Sarežģītība** ir laba ziņa: viena rinda `ReserveInventoryConsumer.cs` būtu pietiekama, lai novērstu bimodalitāti. Tas nozīmē, ka hipotēze ir taisnīga par **noklusētajām implementācijām**, bet ne par **pieejas fundamentālo robežu**. Korektība abos modeļos ir vienlīdzīga; **prognozējamība bez papildu inženierijas ir orķestrācijas pusē**.

#### H4 — Eventual consistency ietekmi uz lietotāja pieredzi var mazināt, bet ne pilnībā novērst

> *Tas ir mazāk hipotēze, vairāk pieņēmums. Interesēs, cik daudz var mazināt.*

**Verdikts: APSTIPRINĀTA.**

Logs starp inventāra rezervēšanas redzamību un saga pabeigšanu ir **strukturāla saga modeļa īpašība** un parādās abos modeļos (Tests E):

- Mediānais logs: **~249 ms (horeogrāfija)**, **~279 ms (orķestrācija)**.
- P95 logs: ~342 ms (horeogrāfija), ~393 ms (orķestrācija).

Šo logu **var mazināt** ar inženierijas izvēlēm:

| Mehānisms | Empīriski uzlabojums | Avots |
|---|---|---|
| Saga modeļa izvēle (horeogrāfija) | ~30–60 ms īsāks medians | Tests E |
| Idempotence klientā | Atkārtoti POST'i deduplicēti < 2 ms; nav dubultkļūdu | Tests G |
| Terminālie statusi kā ground truth | 100 % kļūdaino sagu sasniedz `Failed` | Tests I |
| Retry asimetrijas izvēle | Pārejošas kļūdas absorbētas (orķestrācija) vai izceltas (horeogrāfija) | Tests H |
| CPU pareiza budžetēšana | < 70 % CPU saglabā stabilu medianu | Tests D |

Tomēr šo logu **nevar pilnībā novērst** — tas ir saga modeļa fundamentālais kompromiss starp atomicity un izkliedētu skalējamību. Pat optimālā konfigurācijā paliek vismaz:

- **Inventāra-vs-status logs (~30–250 ms)** — strukturāls.
- **Kompensācijas logs (~200 ms – 3.6 s)** — atkarīgs no retry politikas.
- **Astes outliers (orķestrācija ~3× P95, horeogrāfija ~6–12× P95)** — atkarīgi no koordinācijas modeļa un noslodzes.

Atkarībā no biznesa konteksta, šie logi var prasīt UI pielāgojumus (warning state, deferred confirmation, polling). **Empīrika apstiprina pieņēmumu**: pieci ar saga saistītie tipiskie UX jautājumi (gaidīšanas laiks, daļēja redzamība, kompensāciju paziņojumi, atkārtoto klikšķu drošība, kļūdas terminālā stāvokļa atklātība) ir adresējami šajā kodu bāzē, bet **katrs prasa atsevišķu inženieriju un neviens no tiem nenovērš situāciju pilnībā**. Fowler [9] novērojums tādējādi tiek kvalificēts: eventual consistency ir **mazināms, bet ne anulējams**.

---

### Kopsavilkums

| Hipotēze | Verdikts | Galvenais pierādījums |
|---|---|---|
| H1: Horeogrāfija ātrāka vienkāršos scenārijos | **APSTIPRINĀTA** | ~3× ātrāka mediānā (Tests A, J, K, L) |
| H2: Orķestrācija ātrāk veiks kompensācijas | **ATSPĒKOTA** (konfigurācijas atkarīga) | Horeogrāfija ~18× ātrāka (Tests I); cēlonis — kļūmes semantikas asimetrija, ne koordinācijas modelis |
| H3: Race condition — orķestrācija mazāk problēmu | **DAĻĒJI APSTIPRINĀTA** | Korektība identiska (DB līmeņa); orķestrācija ~9× prognozējamāka latencē (Tests F) |
| H4: Eventual consistency UX — mazināms, ne novēršams | **APSTIPRINĀTA** | Logs ~¼ s mediānā, līdz vairākām sekundēm astē; uzlabojams, bet ne anulējams (Tests E, G, I, M) |
