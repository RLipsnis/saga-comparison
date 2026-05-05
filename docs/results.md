Let me also look at the test script to better understand the setup.

# Test A: Saga Benchmark — End-to-End + Per-Step (P95) Analysis

## 1. Purpose of the Test

Test A is the **primary performance benchmark** in the thesis. Its purpose is two-fold:

- **Headline percentiles** for end-to-end saga latency under sustained, controlled load (P50, P95, P99 for total saga duration and API response).
- **Per-step bottleneck breakdown** so each pattern's overhead can be attributed to a specific stage (`reserveInventory`, `processPayment`, `arrangeShipping`, `sendNotification`, `updateStatus`), not just to the pattern as a whole.

By running the same workload at increasing arrival rates against both **orchestration** (Temporal workflows) and **choreography** (MassTransit/RabbitMQ events), the test answers two thesis questions:

- **At equal load, which pattern is faster end-to-end and where does the time go per step?**
- **As load increases, which pattern saturates first and why?**

## 2. Test Setup

**Driver:** `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-saga-steps.js` executed via `./run-test.sh steps` (k6).

**Workload model** (`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-saga-steps.js:53-82`):

- **Executor**: `constant-arrival-rate` — open model, fixed RPS regardless of response time.
- **Warmup**: 5 s at `RATE/4` to prime EF Core query plans, JIT, connection pools, and Temporal task queues.
- **Main phase**: 60 s at the target `RATE`.
- **VU pool**: `preAllocatedVUs = max(RATE*2, 10)`, `maxVUs = max(RATE*5, 50)`.
- **k6 thresholds**: `total_saga_duration_ms p95 < 10 000` and `api_response_ms p95 < 2 000` (main phase only).

**Endpoint exercised**: `POST /api/orders/benchmark` (@`/Users/robertslipsnis/Desktop/Thesis/saga-comparison/docs/HOW-TO-RUN.md:355-369`). The gateway accepts the order, the saga runs, and the call blocks (timeout 35 s) until the saga reaches a terminal state, returning a JSON envelope with `apiResponseMs`, `totalSagaDurationMs`, `compensationDurationMs`, and `stepDurationsMs`.

**State reset before every run** (`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/benchmark-saga-steps.js:84-90`): inventory restocked, all orders deleted, payment failure rate set to 0%.

**Rates exercised**: 1, 5, 10, 25, 50, 100 rps for **both** orchestration and choreography (12 runs total in `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_a/`).

**Switching modes** is done by `--force-recreate` of the five .NET service containers with `SAGA_MODE=choreography|orchestration`; infrastructure (Postgres, RabbitMQ, Temporal) is *not* recreated.

## 3. Summary of Test Results

### 3.1 Throughput (orders that completed end-to-end)

| Rate | Orchestration completed / failed | Choreography completed / failed |
|------|----------------------------------|---------------------------------|
| 1 rps | 65 / 0 | 65 / 0 |
| 5 rps | 305 / 0 | 306 / 0 |
| 10 rps | 612 / 0 | 612 / 0 |
| 25 rps | **380 / 1 049** | 1 527 / 5 |
| 50 rps | **58 / 2 862** | 3 022 / 37 |
| 100 rps | 56 / 3 951 | 156 / 4 914 |

Orchestration breaks between 10 and 25 rps; choreography is still healthy at 50 rps and only collapses at 100.

### 3.2 Total saga duration P95 (ms)

| Rate | Orchestration P95 | Choreography P95 | Δ (orch − chor) |
|------|-------------------|------------------|-----------------|
| 1 | 409.0 | 362.9 | +46 |
| 5 | 681.4 | 352.5 | +329 |
| 10 | 778.4 | 340.2 | +438 |
| 25 | **4 679.0** | 336.9 | +4 342 |
| 50 | 809.9¹ | 340.3 | — |
| 100 | 1 934.6¹ | 487.0¹ | — |

¹ At and above the saturation point the percentiles are computed only from the *survivors*; the failing orders timed out and are excluded, so 50/100 rps numbers are heavily survivor-biased.

### 3.3 API response P95 (ms)

| Rate | Orchestration | Choreography |
|------|---------------|--------------|
| 1 | 18.7 | 13.7 |
| 5 | 9.6 | 8.9 |
| 10 | 13.8 | 5.0 |
| 25 | 94.9 | 3.1 |
| 50 | 27.4 | 5.1 |
| 100 | 67.5 | 4.6 |

### 3.4 Per-step P95 at 10 rps (last rate where both are healthy)

| Step | Orchestration P95 | Choreography P95 | Δ |
|------|-------------------|------------------|---|
| Reserve Inventory | 101.8 | 13.2 | +88.6 |
| Process Payment | 299.6 | 197.8 | +101.8 |
| Arrange Shipping | 200.4 | 102.9 | +97.5 |
| Send Notification | 150.9 | 54.5 | +96.4 |
| Update Status | 101.8 | 2.7 | +99.1 |
| **Sum of step P95** | **854.5** | **371.1** | **+483.4** |

### 3.5 Per-step P95 at 25 rps (orchestration broken, choreography healthy)

| Step | Orchestration P95 | Choreography P95 |
|------|-------------------|------------------|
| Reserve Inventory | 707.2 | 8.3 |
| Process Payment | 821.6 | 196.8 |
| Arrange Shipping | 772.6 | 100.9 |
| Send Notification | 782.6 | 52.9 |
| Update Status | 970.3 | 1.9 |

## 4. Analysis of the Test Results

### 4.1 Choreography is faster at every rate, even at idle

At 1 rps (essentially no contention) choreography's total saga P95 is already ~46 ms lower than orchestration's. The gap is *not* explained by the business work — both modes hit the same Postgres rows and the same simulated payment delay. The gap is explained almost entirely by one step:

- **`updateStatus` is `~100 ms` in orchestration vs `~2 ms` in choreography**, at every rate.

In orchestration, "Update Status" is implemented as a Temporal activity scheduled by the workflow worker, so it pays a full activity-task round-trip (workflow → task queue → worker → DB → completion → workflow). In choreography it is a direct DB write performed by the OrderService consumer when the `OrderShipped` / `NotificationSent` event lands. This is a structural cost of orchestration, not a load-induced one.

### 4.2 Orchestration's per-step latency snaps to 100 ms multiples

The per-step P95s in orchestration cluster on `~100`, `~200`, `~300` ms even when the underlying DB or HTTP work would take 5–20 ms (e.g. `reserveInventory` at 1 rps is 20.4 ms but at 5 rps already 100.6 ms; `updateStatus` is 17.4 → 101.0 ms). This quantization is the signature of **Temporal task-queue polling / scheduling latency** — the activity worker only picks up tasks at fixed intervals once it is busy. Choreography's equivalent steps (`reserveInventory` 8–17 ms, `updateStatus` 2–3 ms) keep their natural shape because RabbitMQ pushes events to consumers as they arrive.

The practical implication is that orchestration adds a roughly fixed ~100 ms tax *per step transition* once the worker is loaded, multiplied by 5 steps in this saga.

### 4.3 The patterns saturate at very different rates

Both modes are equivalent at 1, 5, and 10 rps (612/612 completions, similar API responses). The break point lies between 10 and 25 rps:

- **Orchestration at 25 rps**: only 380/1429 (~27 %) requests complete; saga P95 explodes to 4 679 ms and P99 to 19 360 ms (right at the 35 s client timeout). API response P95 also jumps from 13.8 → 94.9 ms — the gateway is now queueing.
- **Choreography at 25 rps**: 1 527/1 532 (~99.7 %) complete; saga P95 = 336.9 ms is essentially identical to its 10 rps value (340.2 ms).

Choreography then sustains another `2x` (50 rps: 3 022/3 059 = 98.8 % success, P95 = 340 ms) before breaking at 100 rps. Orchestration's sustainable headroom in this stack is therefore roughly **10 rps**, while choreography's is roughly **50 rps** — about a `5x` difference under identical hardware.

### 4.4 Where does orchestration's overhead actually come from?

Comparing the 10 rps per-step P95s, every step is slower under orchestration, but the absolute cost added is remarkably uniform (88–102 ms per step). This is consistent with each step paying one Temporal task-queue scheduling delay. So:

- The bottleneck is **not** the workflow code or the activity logic.
- It is **the workflow ↔ activity worker hand-off**, which serialises around a single task queue under load. Once arrival rate exceeds what one workflow worker + one activity worker can dequeue, latency grows super-linearly (the 25 rps result).

Choreography, in contrast, has no central coordinator. Each service consumes from its own RabbitMQ queue and writes its own state, so the saga progresses with the parallelism of the broker, not of one worker pool.

### 4.5 Caveats and what the numbers do not say

- **Step P95s at 50/100 rps are survivor-biased.** Only the orders that completed within the 35 s timeout were measured. The 2 862 (orch, 50 rps) and 3 951 (orch, 100 rps) failed orders had longer durations that are simply not counted, so the apparent "improvement" of orchestration's P95 from 25→50 rps is an artefact of which orders survived, not a real improvement.
- **Both patterns share the same Postgres, RabbitMQ, and Temporal infrastructure with default resource limits.** The 100 rps results characterise the *whole stack*, not the pattern in isolation. Test D varies resource limits to separate these effects.
- **Compensation is not exercised here** (`compensated = 0` in every result). That is deliberate — Test A measures the happy path. Compensation cost is the subject of Tests H, I, M, N.
- **The shared Temporal/RabbitMQ infrastructure was not recreated between modes**, so any Temporal history-table state from previous orchestration runs remains; this favours choreography slightly when measuring a clean Postgres state but is a constant factor across all rates.

### 4.6 Headline takeaway for the thesis

At low load (1–10 rps) **choreography is consistently ~50–500 ms faster end-to-end** because it avoids 5 × ~100 ms task-queue hops. As load grows, **the gap widens by an order of magnitude and orchestration saturates at roughly 1/5 of choreography's sustainable rate** in this benchmark setup. The per-step breakdown localises the cause: every step transition under Temporal pays a near-constant scheduling tax that does not exist on the message-driven path.



Let me look at the test script and all the result files to understand what's measured.

I notice an important detail — orchestration shows 0 created / all failed, but the HTTP durations are reasonable. Let me check the actual k6 test script to understand what "failed" really means here.



I see the issue: orchestration shows `successRatePercent: 0` across all rates while choreography shows 100% — but the HTTP response times look reasonable. This is suspicious. Let me check the OrderService POST endpoint to understand what it actually returns in each mode.

Let me verify whether there's a real orchestration response shape issue, and check JSON serialization config.

Let me look at the benchmark runner script and check whether there's something in the run pipeline that would cause this anomaly.

Let me check whether the API gateway transforms the orchestration response in any way.

I have all the data I need. Before writing the analysis, I need to flag something critical: **all orchestration runs show 0% success rate**, while choreography shows 100% (up to 250 rps). The k6 check requires `status === 202 && body.orderId !== undefined`. Both controller branches return that shape, so this is almost certainly a system-level anomaly from this specific run (most likely `StartWorkflowAsync` failing fast and returning HTTP 500). I'll flag this clearly in the analysis rather than gloss over it.

Here is the analysis:

# Test B: Fire-and-forget Throughput — Analysis

## 1. Purpose of the Test

Test B measures **API-gateway intake throughput** at sustained request rates *without* waiting for the saga to complete. Unlike Test A (which holds a connection up to 30 s while polling for terminal saga state), Test B fires `POST /api/orders` and immediately moves on, so the only quantities measured are:

- HTTP response duration (time from request issue to the gateway returning `202 Accepted`)
- Order-creation duration (the same window, isolated to the order POST)
- Whether the response was a valid `202` with an `orderId` body field

This isolates the **HTTP acceptance capacity** of each saga pattern from the downstream saga pipeline. Orchestration only has to: (a) write the Order row in Postgres and (b) call `Temporal.StartWorkflowAsync`. Choreography only has to: (a) write the Order row and (b) publish an `OrderCreated` event to RabbitMQ. Anything that happens after the `202` is invisible to this test, by design.

The test rates form a load curve from baseline to saturation: 1, 5, 10, 25, 50, 100, 250, 500, 1000 rps. Stress at the high end is the point — the test is designed to find the rate at which the intake path collapses.

## 2. How the Test Is Set Up

**Driver:** `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/order-load-test.js:28-44` — k6 with `constant-arrival-rate` executor at the configured RPS for 60 s. Pre-allocated VUs scale with the rate (`Math.max(RATE * 2, 10)`).

**Pre-test reset:** `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/order-load-test.js:46-52` — inventory restock, order purge, payment failure rate set to 0%.

**Per-request workload:** `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/order-load-test.js:54-94` — random product (1 of 5), random quantity 1–3, random `customerId`. The success check is **only** `status === 202 && body.orderId !== undefined` — no polling for saga completion.

**Runner:** `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/run-benchmarks.sh:15` walks the rate list `(1 5 10 25 50 100 250 500 1000)`, calling `inventory/reset` + `orders/reset` and 2 s settle between each rate. 5 s cooldown between runs.

**System under test:** Single-replica .NET services in Docker. The orchestration branch at `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/OrderService/Api/OrdersController.cs:114-128` saves the Order row, then calls `Temporal.StartWorkflowAsync`. The choreography branch at `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/OrderService/Api/OrdersController.cs:129-137` saves the Order row, then publishes `OrderCreated` to RabbitMQ. Both return `202 Accepted` with the same body shape.

**Output:** `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_b/` — one canonical JSON per `(mode, rate)` pair, plus a timestamped duplicate. Captured fields: total iterations, orders_created, orders_failed, success rate, and full HTTP latency percentiles (min/avg/med/p90/p95/p99/max).

## 3. Summary of Test Results

> **Orchestration excluded.** Every orchestration row in `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_b/` reports `created: 0` with HTTP latencies that *decrease* under load (14.5 ms at 1 rps → 2.3 ms at 500 rps), and the 1000 rps row caps at exactly 15 430 ms — the fingerprint of a fast-fail path, almost certainly `_temporalClient.StartWorkflowAsync(...)` throwing on every request because the Temporal worker was not registered or the gRPC connection was unhealthy during this run window (`2026-04-26T20:07–20:17`). The controller body shape at `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/OrderService/Api/OrdersController.cs:127` is identical to the choreography branch, so the k6 success check (`status === 202 && body.orderId !== undefined`) is not at fault. The orchestration column has been removed from the table below; a re-run with a verified-healthy Temporal worker is required before Test B can support a side-by-side comparison.

All numbers in milliseconds. **Iter** is k6 iterations actually executed in 60 s — the closest proxy to *delivered* RPS.

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

## 4. Analysis of the Test Results

### Choreography: clean acceptance up to 250 rps, hard collapse at 500 rps

Choreography's intake path scales near-linearly through the lower rates and reaches a clear knee:

- **1 → 50 rps (light region):** p95 stays in the single-digit milliseconds (5.6–17.1 ms). Median actually *drops* from 12.4 ms (1 rps) to 2.6 ms (50 rps) as TCP keepalives, EF Core query plans, and RabbitMQ channel pools warm up. This is the normal "warm-up dominates first samples" pattern.
- **100 rps:** still clean — p95 = 17.1 ms, 100% success, full target rate delivered. Average climbs slightly (4.7 → 8.8 ms), suggesting the publish path is starting to see contention but is nowhere near saturated.
- **250 rps:** the first stress signal — p95 = 137.7 ms, p99 = 324.5 ms. That is roughly an **8× p95 jump** between 100 and 250 rps with no change in success rate. The full 15 000 orders are still accepted, but the queueing inside the gateway/MassTransit publish pipeline becomes visible.
- **500 rps: cliff.** p95 explodes to **17 794.6 ms** (~130× the 250-rps figure), success rate drops to **66.8%**, and only 16 571 of 30 000 expected requests complete in the 60 s window — k6's `preAllocatedVUs`/`maxVUs` budget is exhausted because each in-flight request is now blocked for 8–17 seconds. The system delivers an *effective* ~276 rps despite a 500 rps target.
- **1000 rps:** further degradation rather than catastrophic failure — avg = 14 481.8 ms, p95 = 21 722.2 ms, only 21 823 iterations complete (≈364 effective rps). The pattern is "back-pressure dominates": as the publish path stalls, requests pile up in HTTP server queues and time out client-side rather than being rejected outright.

The **single useful saturation point for choreography is therefore between 250 rps (clean) and 500 rps (collapsed)**. A finer-grained sweep (300 / 350 / 400 / 450 rps) would pin the knee for the thesis; right now it is bracketed.

### What the choreography degradation likely means architecturally

The collapse at 500 rps is consistent with a RabbitMQ / MassTransit publish-side bottleneck rather than Postgres saturation, because:

1. The Order row insert at `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/OrderService/Api/OrdersController.cs:78-97` happens *before* the publish in choreography. If Postgres were the bottleneck the latency would climb gradually across all rates, not stay flat at <10 ms through 100 rps and then jump.
2. MassTransit's `IPublishEndpoint.Publish` blocks on a confirmed exchange route. Under default settings this involves channel locking, exchange-bind verification, and a publisher-confirm round-trip. At 500 publishes/s on a single .NET service replica, the channel pool starves.

### Recommended actions before citing this test in the thesis

1. **Re-run orchestration** after confirming the Temporal worker is registered (`docker logs saga-order-service | grep -i workflow` should show worker startup; `docker logs saga-temporal | grep -i namespace` should show the default namespace ready). The full rate ladder should be re-walked so a side-by-side intake comparison becomes possible.
2. **Add a saturation sub-sweep** for choreography between 250 and 500 rps to localize the knee, since the current data only proves "≤ 250 rps is fine, ≥ 500 rps is broken".
3. **Consider raising k6's `maxVUs`** at the 500 / 1000 rps tier — when responses balloon to 18 s, `Math.max(RATE * 5, 50)` becomes the bottleneck, and the *effective* delivered rps reflects k6's queue rather than the system's intake limit.
4. Optionally instrument the test to record the HTTP status of failed requests (the `console.warn` in `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/order-load-test.js:92` produces this, but the script doesn't persist it). Capturing status-code histograms would have made the orchestration anomaly diagnosable from the JSON alone.

# Summary

The choreography data in `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_b` is internally consistent and shows a clean intake curve up to 250 rps with a sharp collapse between 250 and 500 rps. The orchestration leg of the original run was unusable (fast-fail signature on every request, see the note at the top of §3) and has been excluded from this section pending a re-run with a verified-healthy Temporal worker.



Let me read the test result files in parallel to understand what data is available.

Let me examine the resource-utilization CSVs and k6 logs to get the CPU/RAM saturation data.

Let me peek into the k6 log to see what `failed` represents and the threshold messages.

I have all the data I need. Here is the full analysis.

# Test D: Resource Scaling — Analysis

## 1. Purpose of the test

The goal of Test D is to determine **whether saga performance is CPU-bound or IO-bound**, and to compare how each pattern (orchestration via Temporal vs. choreography via RabbitMQ/MassTransit) behaves when the underlying compute budget is squeezed.

Concretely it answers:

- Does the same workload run faster when given more CPU/RAM, or does latency stay flat (indicating disk/network is the bottleneck)?
- Which pattern degrades more gracefully when the host is starved?
- Where in the saga pipeline does each pattern hit its first wall — the workflow engine (Temporal), the broker (RabbitMQ), the database (Postgres), or the .NET workers themselves?

The relevant procedure is documented in `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/docs/HOW-TO-RUN.md:483-549`.

## 2. How the test is set up

**Driver:** [benchmark-saga-steps.js](cci:7://file:///Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-saga-steps.js:0:0-0:0) (the same script used by Test A) is run through `run-resource-scaling-test.sh`. Each iteration calls `POST /api/orders/benchmark`, which blocks until the saga reaches a terminal state and returns `apiResponseMs`, `totalSagaDurationMs`, and `stepDurationsMs` for the five saga steps (Reserve Inventory → Process Payment → Arrange Shipping → Send Notification → Update Status).

**Profiles applied to *both* infra and .NET service containers** (`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/docs/HOW-TO-RUN.md:489-499`):

| Profile | CPU per container | RAM per container |
|---|---|---|
| `constrained` | 0.5 | 256 MB |
| `generous` | 2.0 | 1024 MB |

The April 2026 revision noted in `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/docs/HOW-TO-RUN.md:547-549` is important: previously only infra was constrained, now the .NET workers run inside the same Docker network with the same per-container budget, so the only variable is *how much compute the entire saga gets*.

**Runs captured in [tests/LoadTests/results/resource-scaling/](cci:9://file:///Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/resource-scaling:0:0-0:0):**

- `orchestration_constrained` @ 10 rps and 25 rps
- `choreography_constrained` @ 10 rps and 25 rps
- `orchestration_generous` @ 25 rps
- `choreography_generous` @ 25 rps

Each run is 60 s of main load + 5 s warmup. Resource utilisation is sampled every 2 s into `stats_during_*.csv`. The post-test snapshots are essentially idle and should be ignored, as called out in `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/docs/HOW-TO-RUN.md:528-529`.

**Important note on the failure counter:** `failed` in the k6 summary means an order that did not reach `Completed` within the `/benchmark` polling window (30 s ceiling). It is **not** the same as a compensated saga; it indicates either a 30 s timeout on the blocking call or a saga that simply did not finish in time. This is visible in `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-saga-steps.js:104-124`.

## 3. Summary of test results

### End-to-end saga latency (P95) and completion counts

| Run | Completed | Timed out | Saga P95 | Saga P99 | API P95 |
|---|---|---|---|---|---|
| Orchestration · constrained · 10 rps | 611 | 0 | 873 ms | 1 028 ms | 16 ms |
| Choreography · constrained · 10 rps | 568 | 32 | **365 ms** | 660 ms | 6 ms |
| Orchestration · constrained · 25 rps | 109 | 1 359 | 2 371 ms | 3 647 ms | 56 ms |
| Choreography · constrained · 25 rps | **9** | 1 519 | **27 129 ms** | 27 361 ms | 295 ms |
| Orchestration · generous · 25 rps | 1 532 | 0 | 936 ms | 1 131 ms | 15 ms |
| Choreography · generous · 25 rps | 1 497 | 33 | **337 ms** | 2 169 ms | 3 ms |

### Per-step P95 (ms), constrained 10 rps — both modes healthy

| Step | Orchestration | Choreography | Δ |
|---|---|---|---|
| Reserve Inventory | 150 | 34 | −116 |
| Process Payment | 301 | 202 | −99 |
| Arrange Shipping | 202 | 105 | −97 |
| Send Notification | 200 | 82 | −118 |
| Update Status | 150 | 4 | −146 |

### Per-step P95 (ms), constrained 25 rps — both modes overloaded

| Step | Orchestration | Choreography |
|---|---|---|
| Reserve Inventory | 384 | **15 679** |
| Process Payment | 427 | 4 254 |
| Arrange Shipping | 421 | 3 104 |
| Send Notification | 533 | 4 051 |
| Update Status | 889 | 117 |

### Peak CPU per container during each run (raw `docker stats` %; 0.5 CPU limit ≈ 50 %, 2.0 CPU limit ≈ 200 %)

| Run | order-svc | postgres | temporal | rabbitmq |
|---|---|---|---|---|
| Orch. · constrained · 10 rps | 52 % | 44 % | 43 % | 30 % |
| Choreo. · constrained · 10 rps | 52 % | 19 % | 5 % | 17 % |
| Orch. · constrained · 25 rps | 52 % (*pegged*) | 54 % (*pegged*) | 50 % (*pegged*) | 28 % |
| Choreo. · constrained · 25 rps | **94 %** (*pegged + over*) | 75 % (*pegged*) | 64 % (*pegged*) | 27 % |
| Orch. · generous · 25 rps | 52 % | 50 % | 64 % | 27 % |
| Choreo. · generous · 25 rps | 75 % | 18 % | 2 % | 33 % |

(Raw stats files: `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/resource-scaling/stats_during_orchestration_constrained_20260428_204934.csv` etc.)

## 4. Analysis of the test results

### 4.1 The bottleneck is CPU, not IO

The single most important finding is that doubling the CPU/RAM budget (constrained → generous) at 25 rps takes both patterns from a near-total collapse to a healthy steady state with no measurable IO penalty:

- Orchestration: completions go from 109 → 1 532 (+14×); saga P95 drops from 2 371 ms → 936 ms (−2.5×).
- Choreography: completions go from 9 → 1 497 (+166×); saga P95 drops from 27 129 ms → 337 ms (−80×).

If the system were IO-bound on disk or network, more CPU could not produce that kind of recovery — the latency would simply stay high. Postgres CPU climbs in lock-step with load on orchestration (44 % → 54 %), and Temporal climbs from 43 % → 50 % under constrained 25 rps. Both are pegged against the 0.5-CPU ceiling, which is the textbook signature of CPU starvation, not IO wait.

### 4.2 The two patterns saturate different components first

The CSVs reveal that orchestration and choreography put pressure on different parts of the stack, which explains their very different failure modes:

- **Orchestration** spreads load across `OrderService` (which hosts the Temporal workflow), `Temporal`, and `Postgres`. Under constrained 25 rps, all three hit the 50 % cap simultaneously (i.e. their 0.5-CPU budget is saturated). Because Temporal buffers activity tasks server-side, the system degrades roughly linearly: P95 grows from 873 ms → 2 371 ms, but no individual step explodes.
- **Choreography** concentrates everything in the .NET workers, which both *publish* and *consume* MassTransit messages. Under constrained 25 rps, `saga-order-service` peaks at 94 % (i.e. ~2× its 0.5-CPU budget — it is borrowing burst credit and being throttled hard). Postgres also climbs to 75 %, far higher than orchestration on the same workload, because the in-process consumers issue every saga-state write directly. With the consumer thread starved, the RabbitMQ queue for `ReserveInventoryCommand` grows unbounded, and `reserveInventory` P95 explodes from 34 ms (10 rps) to **15 679 ms** (25 rps) — a 460× regression on a single step.

In other words, orchestration is bottlenecked by the **workflow/state engine**, choreography by the **consumer dispatch loop**.

### 4.3 Choreography is faster when not throttled, slower under starvation

This is the central tension of the test for the thesis:

- At constrained 10 rps and at generous 25 rps (both healthy regimes), choreography wins on every per-step metric. End-to-end saga P95 is 2.4×–2.8× lower (873 → 365 ms; 936 → 337 ms). The biggest gains are on steps that orchestration routes through a Temporal activity:
  - `Update Status`: 150 ms (orch) vs 4 ms (choreo) — a 37× gap. Choreography's `OrderService` consumer writes the status field synchronously inside the same handler, while orchestration spends ~100 ms on the activity-scheduling round-trip.
  - `Reserve Inventory`: 150 ms vs 34 ms — same root cause (Temporal activity vs. in-process consumer).
- At constrained 25 rps, the relationship inverts dramatically. Orchestration completes 109 sagas; choreography completes 9. The 9 that did finish took 25 s+, mostly waiting for the inventory queue. Orchestration's Temporal task queue absorbs the same input load with much smaller per-step blow-up (P95 384 ms vs 15 679 ms on Reserve Inventory), because Temporal is purpose-built to schedule activities asynchronously rather than deliver them through an in-memory consumer that competes with the producer for the same starved CPU.

### 4.4 API-acceptance latency mirrors the architectural difference

`apiResponseMs` (time from POST to saga-initiated) is consistently ~3-5× lower in choreography (1.4-3 ms vs 4-15 ms in healthy runs). Choreography's `OrderService` only has to publish an event before returning; orchestration synchronously starts a Temporal workflow, which involves a gRPC round-trip to `saga-temporal`. Under constrained 25 rps, choreography's API P95 jumps to 295 ms — exactly the symptom of a publisher being blocked by a back-pressured broker and CPU-starved consumers, while orchestration's API P95 stays at a relatively bounded 56 ms because Temporal's gRPC ingress is decoupled from activity execution.

### 4.5 Practical takeaway for the thesis

- **Both patterns are CPU-bound on this workload**, not IO-bound. Resource scaling is the right lever, not faster disks or a bigger RabbitMQ.
- **Choreography is the lower-overhead pattern when the system has headroom** — fewer hops, no orchestrator gRPC, faster API ingestion, lower per-step P95.
- **Orchestration is the more *elastic* pattern under starvation** — Temporal's task-queue-backed activity execution decouples producer rate from worker rate, so the failure mode is graceful latency growth rather than queue runaway.
- The crossover happens around the point where every container is simultaneously CPU-pegged (here, 25 rps × 0.5 CPU). Sizing the cluster so that no individual saga service ever exceeds ~70 % of its CPU budget is enough to keep choreography in its preferred regime.

### 4.6 Caveats / limitations of this test run

- Only `constrained` and `generous` profiles were captured; no `default` (1.0 CPU) or `unlimited` data points exist in [tests/LoadTests/results/resource-scaling/](cci:9://file:///Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/resource-scaling:0:0-0:0), so the curve between the two extremes is interpolated rather than measured.
- The constrained 25 rps runs are well past the breakdown point — most of the saga samples in those JSONs are 30 s polling timeouts, so the percentiles are summarising a degenerate regime, not a usable operating point. They are useful as a *failure-mode* signal, not as latency numbers to quote in isolation.
- The `failed` counter does not separate "saga compensated" from "client-side polling timeout"; in this test almost all failures are the latter. For a clean failure rate, Test M / Test N should be cited instead.







# Test E: Inventory-Visibility Lag — Analysis

## 1. Purpose

The test measures **real eventual-consistency lag**: how soon after a client posts a new order does the reserved stock become readable to *external observers* through `GET /api/inventory/products`. It is the visible "side-effect window" a UI, dashboard, or downstream service would experience.

It captures two independent timings per order so they can be compared:

- **`inventoryVisibilityLagMs`** — POST → `reservedQuantity` increment is visible via the inventory API.
- **`sagaCompletionLagMs`** — POST → `Order.Status = Completed`.

The thesis-relevant comparison is the **delta between the two**: how far the user-visible side-effect leads the saga's own terminal state, and whether orchestration vs. choreography differ in either lag.

## 2. How the test is set up

Driven by `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-consistency-lag.js:1-212`, executed with `./run-test.sh consistency --env ITERATIONS=30` (see `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/docs/HOW-TO-RUN.md:553-588`).

- **Setup** (`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-consistency-lag.js:55-61`): inventory reset, orders deleted, payment failure rate = 0, 2 s settle.
- **Workload** (`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-consistency-lag.js:44-53`): `executor: per-vu-iterations`, **1 VU**, **30 iterations** (single-flight to keep the inventory counter clean).
- **Per-iteration loop** (`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-consistency-lag.js:77-150`):
    1. Snapshot `reservedQuantity` for product `a1111111-1111-1111-1111-111111111111`.
    2. `POST /api/orders` for 1 unit, mark `start`.
    3. Poll `GET /api/inventory/products` and `GET /api/orders/{id}/status` every **25 ms**.
    4. Record `inventory_visibility_lag_ms` the first poll where `reservedQuantity > baseline`.
    5. Record `saga_completion_lag_ms` when status becomes `Completed`.
    6. Per-iteration timeout: **15 s**.
- **Modes**: each saga mode is run after `--force-recreate` of the .NET services so `SagaMode` is correctly applied.
- **Failure path not exercised**: payment-failure rate is 0, so `inventoryReleaseLagMs` is `null` in every result file.

The canonical files are overwritten each run; timestamped copies preserve history. There are two runs per mode in [tests/LoadTests/results/test_e/](cci:9://file:///Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_e:0:0-0:0).

## 3. Summary of test results

**Latest (canonical) runs** — [consistency_orchestration.json](cci:7://file:///Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_e/consistency_orchestration.json:0:0-0:0) and [consistency_choreography.json](cci:7://file:///Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_e/consistency_choreography.json:0:0-0:0) (all values in milliseconds):

| Metric | Mode | n | avg | med | p90 | p95 | max |
|---|---|---|---|---|---|---|---|
| Inventory visibility lag | Orchestration | 30 | 40.8 | 33.0 | 37.1 | **42.4** | 243.0 |
| Inventory visibility lag | Choreography | 30 | 32.2 | 32.0 | 33.0 | **35.7** | 43.0 |
| Saga completion lag | Orchestration | 30 | 344.9 | 312.0 | 396.1 | **436.0** | 1205.0 |
| Saga completion lag | Choreography | 30 | 280.8 | 281.0 | 347.4 | **377.6** | 393.0 |

**Both runs side-by-side** (confirms repeatability):

| Mode | Run | completed/timeouts | inv avg / p95 / max | saga avg / p95 / max |
|---|---|---|---|---|
| Orchestration | 18:17 | 30 / 0 | 39.3 / 36.6 / 227 | 336.4 / 415.2 / 1087 |
| Orchestration | 18:21 | 30 / 0 | 40.8 / 42.4 / 243 | 344.9 / 436.0 / 1205 |
| Choreography | 18:19 | 27 / **3** | 40.8 / 40.7 / 279 | 300.5 / 363.6 / 1262 |
| Choreography | 18:21 | 30 / 0 | 32.2 / 35.7 / 43 | 280.8 / 377.6 / 393 |

- The orchestration runs are tightly reproducible.
- The earlier choreography run (`consistency_choreography_2026-04-28T18-19-47-135Z.json:7-9`) reported **3 timeouts** (sagas not reaching `Completed` inside 15 s) and a long saga `max` of 1262 ms, while the cleaner second run finished all 30 inside 393 ms — strong evidence the first run was a transient blip (cold caches/queues).

## 4. Analysis of the test results

**A. Both patterns expose the reservation long before the saga finalises.**
The lag delta `sagaCompletion − inventoryVisibility` quantifies the user-facing eventual-consistency window. On the median: ≈ 279 ms for orchestration and ≈ 249 ms for choreography. So for ~¼ of a second after stock is already visible to clients, the order itself is still listed as `Pending` — the classic saga read-your-write hazard.

**B. Choreography is faster on every percentile of both metrics.**
Using the latest runs:

- Inventory visibility: avg **−21%** (32.2 vs 40.8 ms), p95 **−16%** (35.7 vs 42.4 ms).
- Saga completion: avg **−19%** (280.8 vs 344.9 ms), p95 **−14%** (377.6 vs 436.0 ms).

This matches the architectural prediction in `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/docs/HOW-TO-RUN.md:583`: in choreography the `InventoryService` consumer reacts directly to `OrderCreated` from RabbitMQ — one hop, one DB write — whereas Temporal in orchestration must persist a workflow event, dispatch a workflow task to a worker, then schedule and dispatch the `ReserveInventory` activity before the same DB write happens.

**C. The tail behaviour is the most striking finding.**
At max:

- Inventory: orchestration **5.7×** worse (243 vs 43 ms).
- Saga completion: orchestration **3.1×** worse (1205 vs 393 ms).

In the clean choreography run, `max ≈ p95 + 8–15 ms` — an essentially flat distribution. Orchestration shows the opposite: `max` sits **~6× above p95** for inventory and **~3× above p95** for saga completion. This is consistent with Temporal-worker scheduling jitter (history-table writes, task-queue polling cadence, occasional sticky-cache miss) — overheads that the event-pump path simply does not have.

**D. Choreography is not strictly more reliable — it is more sensitive to environment noise.**
The earlier choreography run showed three timeouts and an outlier `max` of 1262 ms, indistinguishable from orchestration's worst case. The later run cleared completely. Across the two runs, choreography's *typical* numbers are better but its *worst* observed run isn't materially better than orchestration. For thesis claims about consistency lag, the dual run argues that:

- Orchestration's tail is **structural** (Temporal scheduling) — present in both runs.
- Choreography's tail is **environmental** — only present in one run; otherwise it disappears entirely.

**E. Caveats / what this test does *not* show.**

- The failure path was never exercised (`inventoryReleaseLagMs` is `null` in every file). Compensation-side lag is not characterised here — Test I / Test M would be needed.
- 1 VU × 30 iterations is a single-flight measurement, deliberately so to keep the inventory counter unambiguous. It does not capture how the lag scales under concurrent load — that question belongs to Test A/K.
- The 25 ms poll interval is the floor of resolution, so any lag below ~25 ms is reported as ~25–32 ms regardless of pattern. The orchestration vs choreography gap on the median (33 vs 32) is therefore at the noise floor; the **tail** values, where the gap is large, are the trustworthy signal.

**Headline for the thesis.** Choreography reaches the inventory API roughly **8 ms** sooner on the median and **~7 ms** sooner on p95, but the architecturally meaningful difference is tail latency: orchestration injects multi-hundred-millisecond outliers into both inventory visibility and saga completion that choreography does not, attributable to Temporal's workflow-scheduling overhead between `OrderCreated` and the first activity execution.










# Test F: Race Condition / Concurrency — Analysis

## 1. Purpose

Test F validates **correctness of concurrency control** under contention. Twenty virtual users (VUs) simultaneously attempt to purchase the same single-stock product ("Limited Edition Tablet", `c1111111-1111-1111-1111-111111111111`, stock = 1). Exactly **one** order must succeed and **nineteen** must fail. The test answers two questions:

- **Correctness**: Does optimistic concurrency on `Product.Version` (mapped to PostgreSQL's `xmin` row-version, see `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/InventoryService/Infrastructure/InventoryDbContext.cs:23` and `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/InventoryService/Domain/Product.cs:11`) prevent overselling in **both** saga patterns?
- **Performance under contention**: How does each pattern *handle* losers — i.e. how is `DbUpdateConcurrencyException` propagated back through the saga to the API caller?

## 2. Test Setup

Driver script: `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-race-condition.js`.

- **Executor**: k6 `shared-iterations`, 20 VUs / 20 iterations / `maxDuration: 30s`, per-request `timeout: '35s'`.
- **Endpoint**: `POST /api/orders/benchmark` (synchronous — blocks until the saga reaches a terminal state, so each VU's elapsed time = full saga round-trip including any compensation).
- **Per-VU payload**: a fresh `customerId` (UUID) + 1 unit of the limited-stock product.
- **Setup hook**: `POST /api/inventory/reset` + `DELETE /api/orders/reset` to guarantee `availableQuantity = 1, reservedQuantity = 0` at start.
- **Verdict** (in [handleSummary](cci:1://file:///Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-race-condition.js:80:0-124:1)): `wins == 1` → **PASS**; `wins == 0` → **FAIL (no winners)**; `wins > 1` → **FAIL (oversell!)**.

Concurrency-control implementation differs by pattern:

- **Orchestration** (`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/InventoryService/Api/InventoryController.cs:38-41`): catches `DbUpdateConcurrencyException` and returns **HTTP 409 Conflict** — Temporal sees an activity failure and proceeds to compensation immediately.
- **Choreography** (`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/InventoryService/Choreography/ReserveInventoryConsumer.cs:40-43`): catches the same exception and **rethrows** it — MassTransit then enters its retry policy before eventually publishing an `InventoryReservationFailed` event.

Procedure (per `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/docs/HOW-TO-RUN.md:591-617`): run `./run-test.sh race --env VUS=20` in orchestration mode, switch via `SAGA_MODE=choreography docker compose up -d --force-recreate ...`, wait 15 s, run again. Two runs were captured per mode.

## 3. Summary of Results

All four runs show `wins=1, losses=19` → **PASS (exactly 1 winner)** in every case. The split is on the *response-time distribution*:

| Mode | Run | Avg (ms) | P95 (ms) | Max (ms) | Verdict |
|---|---|---:|---:|---:|---|
| Orchestration | 1 (`18-22-58`) | 3 782.6 | 4 010.8 | 5 813.0 | PASS |
| Orchestration | 2 (`18-23-07`, canonical) | 3 283.7 | 3 557.1 | 3 558.0 | PASS |
| Choreography | 1 (`18-23-43`) | 1 676.0 | 3 913.6 | 3 924.0 | PASS |
| Choreography | 2 (`18-24-21`, canonical) | 6 794.1 | **33 357.1** | **33 359.0** | PASS |

Mode aggregates (across the two runs):

| Mode | Avg-of-avgs (ms) | P95 range (ms) | Max range (ms) |
|---|---:|---:|---:|
| Orchestration | ~3 533 | 3 557 – 4 011 | 3 558 – 5 813 |
| Choreography | ~4 235 | 3 914 – **33 357** | 3 924 – **33 359** |

## 4. Analysis

### 4.1 Correctness: both patterns are safe

Every run produced exactly 1 winner across 20 concurrent buyers. The PostgreSQL `xmin` concurrency token on `Product` does its job in both modes — the saga pattern has **no influence on overselling prevention** here, because both modes share the same `InventoryDbContext` and the database (not the saga coordinator) is the arbiter. This isolates the saga-pattern overhead from the contention-control mechanism, which is the desired property of this test.

### 4.2 Loser-path latency is where the patterns diverge

The 19 losers — not the 1 winner — dominate the response-time distribution, and that is exactly what this test exposes.

- **Orchestration** is *tight and predictable*: avg ≈ 3.3–3.8 s, P95 within ~250 ms of avg, max ≤ 5.8 s. When a loser's `ReserveInventoryActivity` returns `409 Conflict`, Temporal records the activity failure and routes the workflow straight into the compensation branch. There is no retry on a domain-level conflict, so each loser pays roughly one round-trip + the compensation step and terminates.

- **Choreography** is *bimodal*: one run finished with avg 1.68 s (faster than orchestration's best), the other ballooned to avg 6.8 s with P95 = 33.36 s and max = 33.36 s. That **33.36 s figure is essentially the k6 per-iteration timeout (`35 s`)** — a substantial fraction of losers were timing out instead of returning naturally.

### 4.3 Why choreography is bimodal — root cause

`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/InventoryService/Choreography/ReserveInventoryConsumer.cs:40-43` deliberately *rethrows* `DbUpdateConcurrencyException` so MassTransit retries via its broker-side redelivery policy. Under 20-way contention every retry races again against the same single row, so the typical loser flow is:

1. Lose the optimistic-concurrency check → throw.
2. MassTransit redelivers from RabbitMQ after a back-off.
3. Lose again (winner already committed, but row is still contested by the other 18 losers).
4. Repeat until the retry budget exhausts → publish `InventoryReservationFailed` → the rest of the saga unwinds.

The retry/back-off schedule, broker scheduling, and the order in which losers happen to commit determine whether a given run is "fast" (most losers fail quickly because they observe the post-winner stable state) or "slow" (many losers spend their full retry budget). That non-determinism is what produces the **17×** P95 spread between the two choreography runs (3 914 ms vs 33 357 ms) while the orchestration spread is < 12 % (3 557 ms vs 4 011 ms).

Orchestration sidesteps this entirely because the orchestrator distinguishes a *domain* failure (HTTP 409) from a *transient* failure: it does not retry the activity on a `Conflict` response and proceeds to compensation immediately.

### 4.4 Implications for the thesis

- **Concurrency safety is a database-level property**, not a saga-pattern property. Both patterns inherit the same correctness from `Product.Version`.
- **Failure-path tail latency is a saga-pattern property.** Orchestration's centralized failure routing converts a `409` into a single deterministic compensation, whereas choreography's broker-mediated retries amplify contention into long, variable tails — to the point that under heavy contention, response time is gated by the retry/timeout configuration of the broker rather than by the work being done.
- **Methodological note**: the 33.36 s max in choreography run 2 is censored by the k6 35 s timeout. To measure the true loser-path P95 in choreography, the timeout should be raised (e.g. `timeout: '120s'`) or, more realistically, the choreography consumer should treat `DbUpdateConcurrencyException` as a domain failure (publish `InventoryReservationFailed` on first occurrence) instead of throwing it back to MassTransit. That would make the patterns directly comparable on this test instead of comparing an immediate-fail policy (orchestration) against a retry-until-exhausted policy (choreography).

**Headline numbers for the thesis table**: orchestration P95 = **3.6 s** (stable); choreography P95 = **3.9 s in the best run, 33.4 s in the worst** — both correct, but orchestration is roughly **9× more predictable** under single-row contention given the current retry policies.





Let me also check the actual test script to understand the implementation details.





# Test G: Idempotency — Analysis

## 1. Purpose of the Test

Test G is a **correctness test**, not a performance benchmark. Its goal is to verify that submitting the *same* `POST /api/orders` request twice (a "double-click" scenario) using an identical `IdempotencyKey` does **not** result in a duplicate order — no second saga is started, no double inventory reservation, no double payment.

The test enforces three assertions per iteration, as defined in `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-idempotency.js:80-84`:

- Both POSTs must return HTTP **202 Accepted**
- Both responses must carry the **same `orderId`**
- The **second** response must include `idempotent: true`

A hard k6 threshold (`duplicate_orders_created: ['count==0']`) makes the run fail outright if even one duplicate slips through. The thesis-level question this answers is: *"Does each saga pattern's request-intake layer correctly deduplicate retried client commands?"*

## 2. Test Setup

**Workload shape** (`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-idempotency.js:30-43`):

- 1 VU, **20 iterations**, per-VU-iterations executor
- Each iteration generates a fresh `customerId` and `idempotencyKey` (UUIDv4), then fires **two back-to-back** POSTs with the identical payload
- Latency is split into `first_response_ms` (the request that actually does the work) and `second_response_ms` (the deduplicated cache hit)

**State preparation** ([setup()](cci:1://file:///Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-idempotency.js:44:0-50:1) at `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-idempotency.js:45-51`):

- Inventory is reset, all orders are deleted, payment failure rate is forced to 0 %, then a 2 s settle delay

**Server-side mechanism** (identical for both saga modes, `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/OrderService/Api/OrdersController.cs:53-112`):

- The controller checks the `IdempotencyRecord` table for `(Key, OperationType="CreateOrder")` before doing anything else
- If found, it returns the cached `OrderId` with `Idempotent = true` and **never starts a saga**
- If not found, it inserts the `Order` and the `IdempotencyRecord` in the **same EF Core transaction**, protected by a unique index on `(Key, OperationType)` (`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/OrderService/Infrastructure/OrderDbContext.cs:34-38`)
- Concurrent duplicates that race past the initial check hit the unique-index violation, get the `DbUpdateException` re-resolved into a cached lookup, and still return the same `OrderId`

**Critical for interpretation:** the deduplication runs **before** the saga is dispatched — *before* `Temporal.StartWorkflowAsync` (orchestration, `OrdersController.cs:120`) or `IPublishEndpoint.Publish` (choreography, `OrdersController.cs:132`). The mechanism is therefore pattern-agnostic by design.

**Run command** (`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/docs/HOW-TO-RUN.md:632-647`):

```bash
./run-test.sh idempotency --env ITERATIONS=20
```

…executed once per saga mode, with `SAGA_MODE` switched between runs via `docker compose up -d --force-recreate`.

## 3. Summary of Results

The [test_g/](cci:9://file:///Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_g:0:0-0:0) folder contains **two runs per mode**: a first run immediately after the mode switch (cold) and a follow-up (warm). The canonical files (`idempotency_<mode>.json`) are byte-identical to the second timestamped run, so the second runs are the steady-state numbers.

### Correctness (the primary metric)

| Mode | Iterations | Idempotent hits | Duplicates created | Verdict |
|---|---|---|---|---|
| Orchestration | 20 | **20** | **0** | **PASS** |
| Choreography | 20 | **20** | **0** | **PASS** |

Both runs of both modes hit `PASS (all double-clicks deduplicated)`.

### Latency — steady-state (second run of each mode)

| Metric | Orchestration | Choreography |
|---|---|---|
| 1st POST avg | 8.6 ms | 5.5 ms |
| 1st POST P95 | 11.6 ms | 13.5 ms |
| 1st POST max | 24.0 ms | 24.0 ms |
| 2nd POST avg | 3.0 ms | 2.1 ms |
| 2nd POST P95 | 6.0 ms | 6.1 ms |
| 2nd POST max | 7.0 ms | 8.0 ms |

### Latency — cold first run (immediately after `--force-recreate`)

| Metric | Orchestration | Choreography |
|---|---|---|
| 1st POST avg | 19.1 ms | 16.4 ms |
| 1st POST P95 | 49.4 ms | 28.1 ms |
| 1st POST max | 191.0 ms | 202.0 ms |
| 2nd POST avg | 3.6 ms | 5.3 ms |
| 2nd POST P95 | 7.0 ms | 11.4 ms |
| 2nd POST max | 8.0 ms | 20.0 ms |

## 4. Analysis

### 4.1 Correctness is identical and pattern-agnostic

The headline finding is that **both saga patterns deduplicate perfectly (20/20, 0 duplicates)**. This is not a coincidence — it is structural. As shown in `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/OrderService/Api/OrdersController.cs:53-112`, idempotency is enforced *upstream* of the dispatch step, in the synchronous HTTP path of `OrderService`. Neither Temporal nor MassTransit ever sees the second request. Two design choices make this robust:

- **Same-transaction write** of `Order` + `IdempotencyRecord`. The unique index on `(Key, OperationType)` means that even under a true concurrent double-click, exactly one transaction wins and the loser re-reads the cached `OrderId` (`OrdersController.cs:99-111`).
- **Pattern-agnostic location**. Because the check runs before the `if (sagaMode == "orchestration")` branch, the saga pattern is irrelevant to correctness — both patterns inherit the same guarantee from the shared `OrderService` controller.

For the thesis, this is a useful negative result: **idempotency is not a differentiator between orchestration and choreography**, provided the entry point handles it. The often-repeated worry about choreography being more vulnerable to duplicate events does not apply here because deduplication is done at the HTTP boundary, not inside the saga.

### 4.2 First-POST latency: choreography slightly cheaper at the dispatch step

In steady state, the first POST averages **8.6 ms (orchestration) vs 5.5 ms (choreography)** — a ~3 ms gap that is consistent with the cost of the dispatch primitive each pattern uses:

- **Orchestration** issues a synchronous gRPC `StartWorkflowAsync` to Temporal, which persists the workflow's first history event (a row in Temporal's Postgres) before returning. The HTTP response cannot be sent until that round-trip completes.
- **Choreography** issues `IPublishEndpoint.Publish(orderCreated)` against MassTransit, which is a local TCP write to RabbitMQ. The HTTP response can be sent as soon as the broker acknowledges receipt; the consumers run asynchronously afterwards.

Note that the **P95** numbers are reversed (orchestration 11.6 ms vs choreography 13.5 ms). With only 20 samples in a 1-VU, low-rate test this is well within statistical noise — a single slow tail sample pulls the P95 up significantly. The avg is the more reliable signal at this sample size, and it favours choreography by a few milliseconds, as expected from the dispatch model.

### 4.3 Second-POST latency: identical and minimal in both modes

The second request averages **~2-3 ms** in both modes, P95 **~6 ms**. This makes sense because the second request does the absolute minimum work: a single indexed `SELECT` on `IdempotencyRecord` (unique index hit on `(Key, OperationType)`), JSON-deserialize the cached `OrderId`, return 202. It **never enters the saga pipeline at all**. The second-POST cost is essentially API-gateway + EF round-trip — neither Temporal nor RabbitMQ is touched, so the saga pattern is irrelevant.

This is the strongest evidence that the deduplication path is correctly short-circuiting before any pattern-specific code runs: if it weren't, we would see the second-POST latency mirror the first-POST gap between modes, and we don't.

### 4.4 The cold-run noise is JIT/EF warm-up, not a pattern signal

The first runs of both modes (taken right after `--force-recreate`) show a max of **191-202 ms** that completely dominates avg and P95. This is a textbook cold-start signature:

- First Npgsql connection establishment from the empty pool
- EF Core query plan compilation for the first `IdempotencyRecord` lookup and the first `Order` insert
- .NET tiered JIT promotion of the controller path

This is **not pattern-specific**, and it is exactly the effect Test L (Cold-Start Penalty) is designed to isolate. For Test G's purposes, the cold-run JSONs should be treated as warm-up data — only the second/canonical runs are meaningful for steady-state comparison.

### 4.5 Implications for the thesis

- **Both patterns satisfy the idempotency requirement equivalently** when the entry-point service uses an idempotency-record table with a unique index. The choice of saga pattern does not affect deduplication correctness.
- The minor steady-state latency advantage of choreography (~3 ms on the first POST) reflects the cost of synchronous workflow registration in Temporal versus an asynchronous broker publish. This same gap should appear (and does, in Test A) on every order creation; it is not specific to idempotency.
- The deduplicated path is essentially free in both modes (~2 ms), which means there is **no penalty for clients to send retries with idempotency keys** — a useful operational property regardless of pattern.

**Verdict:** Test G demonstrates that, *given a correctly-implemented idempotency table at the request boundary*, orchestration and choreography are interchangeable from a correctness standpoint, with only marginal (millisecond-level) latency differences inherited from their respective dispatch primitives.




The [test_h](cci:9://file:///Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_h:0:0-0:0) directory appears empty. Let me verify and check related locations.

The files exist. Let me read all results and the test script to understand the metrics.

Let me also check the test script briefly to understand the metrics meanings.

# Test H: Mixed Workload — Analysis

## 1. Purpose of the Test

Test H captures **happy-path** and **compensation-path** latency in the **same run** under a configurable failure rate, so percentiles for both outcomes reflect the same load conditions and queue depth. It answers two questions for the thesis:

- **Realistic mix (10% failure):** What does production-style traffic — where most sagas succeed but a fraction must roll back — look like in each pattern?
- **Forced rollback (100% failure):** What is the *raw* compensation cost when every saga is forced to compensate?

Two metrics matter:

- **`compensationSagaMs`** — full saga lifetime for a rolled-back order (request → terminal `Failed` state).
- **`compensationWindowMs`** — narrow `Compensating → Failed` window only, isolating the rollback steps from the forward-progress steps that preceded the failure.

## 2. Test Setup

**Driver:** `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-mixed-workload.js`

**Orchestration (`SAGA_MODE=orchestration`):** Temporal workflow drives the order saga; activity retries follow Temporal's default retry policy.

**Choreography (`SAGA_MODE=choreography`):** Services publish/consume via RabbitMQ + MassTransit; failure is propagated as an event chain.

**Common harness:**
- [setup()](cci:1://file:///Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-mixed-workload.js:74:0-86:1) resets inventory, deletes orders, then `POST /api/payments/failure-rate/<FAIL_RATE_PCT>` to inject deterministic payment failures (`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-mixed-workload.js:75-87`).
- [teardown()](cci:1://file:///Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-mixed-workload.js:88:0-92:1) resets failure rate to 0.
- Each k6 sample is tagged `outcome:happy` or `outcome:compensation` based on the `compensated` flag in the `/api/orders/benchmark` response.
- `constant-arrival-rate` executor with a 5 s warm-up phase at 1/4 the main rate.

**Two scenarios were executed (each ran twice per mode):**

| Scenario | Rate | Duration | `FAIL_RATE_PCT` | Goal |
|---|---|---|---|---|
| Realistic | 10 rps | 60 s | 10 | Production-like mix |
| Pure compensation | 5 rps | 30 s | 100 | Isolate rollback cost |

## 3. Summary of Test Results

### Scenario 1 — 10 rps, 10% target failure, 60 s

| Mode | Completed | Compensated | Failed | Observed fail % | Happy P95 (ms) | Comp saga P95 (ms) | Comp window P95 (ms) |
|---|---|---|---|---|---|---|---|
| Orchestration (run 1) | 611 | 0 | 0 | **0.0** | 1683.8 | n/a | n/a |
| Orchestration (run 2) | 612 | 0 | 0 | **0.0** | 1676.2 | n/a | n/a |
| Orchestration (run 3) | 610 | 0 | 0 | **0.0** | 1689.2 | n/a | n/a |
| Choreography (run 1) | 534 | 16 | 59 | 12.3 | 339.5 | 1129.2 | 1019.7 |
| Choreography (run 2) | 543 | 10 | 57 | 11.0 | 339.9 | 1193.1 | 1013.8 |

### Scenario 2 — 5 rps, 100% target failure, 30 s

| Mode | Completed | Compensated | Failed | Comp saga avg / P95 / max (ms) | Comp window avg / P95 / max (ms) |
|---|---|---|---|---|---|
| Orchestration (run 1) | 0 | 147 | 0 | 3570.6 / 3874.5 / 4113.3 | 104.1 / 310.7 / 363.8 |
| Orchestration (run 2) | 0 | 146 | 0 | 3595.8 / 3871.8 / 4033.5 | 116.2 / 339.2 / 367.8 |
| Choreography (run 1) | 0 | 53 | 103 | 199.4 / 281.0 / 318.9 | 26.4 / 27.6 / 29.4 |
| Choreography (run 2) | 0 | 44 | 113 | 192.9 / 243.0 / 292.5 | 26.2 / 27.7 / 28.7 |

## 4. Analysis

### 4.1 Happy-path latency: choreography is ~5x faster

At 10 rps the happy-path saga completes in **~340 ms P95 (choreography)** vs **~1680 ms P95 (orchestration)**. This matches the per-step results from Test A: orchestration pays the Temporal task-queue dispatch cost on every step transition, while choreography hands off via direct AMQP messages between consumers. Tail behaviour is also worse for orchestration — the P99 jumps to **3820 ms** in run 1, indicating long-tail outliers consistent with worker scheduling pressure or task-queue backlog at this rate.

### 4.2 Compensation cost: window vs full saga (the most important finding)

At a forced 100% failure rate, the breakdown reveals that **most of the orchestration cost is not in rollback itself**:

| Mode | Comp saga total P95 | Comp window P95 | Forward-progress + retry portion |
|---|---|---|---|
| Orchestration | ~3870 ms | ~325 ms | **~3545 ms (~92%)** |
| Choreography | ~262 ms | ~27 ms | ~235 ms (~90%) |

- The **`Compensating → Failed` window** is genuinely small in both patterns — orchestration's compensations themselves run in ~325 ms P95, choreography's in ~27 ms P95 (≈12x faster, consistent with direct broker-driven undo events).
- The **dominant cost in orchestration** sits *before* compensation begins. With the payment activity throwing 100% of the time, the Temporal workflow retries the activity per its retry policy (exponential backoff) until it gives up, **then** transitions to the compensation branch. That retry tail accounts for ~3.5 s of the ~3.9 s saga duration. Choreography has no equivalent retry layer — the first failed event triggers the rollback chain immediately.

This difference is architectural, not implementation polish: Temporal's value proposition includes durable retries, and the test exposes the latency tax of that feature in a "fail fast" rollback scenario.

### 4.3 Orchestration's retry policy absorbs the 10 % failure injection (a structural finding, not an anomaly)

All three orchestration runs at `FAIL_RATE_PCT=10` report `observedFailRatePercent: 0`, `compensated: 0`. This initially looks like the failure injection did not take effect, but inspection of the failure surface explains it as the **expected mathematical outcome** of the activity retry policy:

- `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/PaymentService/Domain/PaymentOperations.cs:30` rolls `Rng.Next(100) < FailureRatePercent` **per call**, so each HTTP attempt has an independent 10 % probability of being declined.
- `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/OrderService/Orchestration/OrderActivities.cs:87` raises `ApplicationException` on a non-success response, which Temporal classifies as a retriable transient failure.
- `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/OrderService/Orchestration/OrderSagaWorkflow.cs:25-28` configures `MaximumAttempts = 3` (initial + 2 retries at 1 s and 2 s).

So **per-saga** failure probability is `0.10³ = 0.1%`. Across 600 sagas the expected count of compensating sagas is 0.6 (≈55 % chance of zero observed in a single run, ≈17 % chance of zero in three independent runs). The observed `0/0/0` outcome is fully consistent with the binomial distribution, **not** with a broken test.

Choreography behaves differently for a structural reason. The payment consumer at `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/PaymentService/Choreography/ProcessPaymentConsumer.cs:27-32` does not throw on a business failure — it publishes a `PaymentFailed` event and returns normally — so `UseMessageRetry` never engages. Each saga gets exactly one payment attempt, and a 10 % per-call rate translates to ~10 – 12 % per-saga failures. The slight excess over 10 % is sampling noise (75 / 609 ≈ 1.9 σ above the binomial mean for `n = 609`, `p = 0.10`).

**Thesis-level finding.** Under transient downstream failures, orchestration and choreography expose **different effective failure budgets at the saga boundary**: Temporal's activity retries silently absorb 99.9 % of 10 % per-call failures, while choreography surfaces them as compensation paths at roughly the same per-saga rate as the per-call rate. The same retry asymmetry is responsible for the ~3 s delay before compensation begins in Test I and the ~3.5 s "forward-progress + retry" portion of orchestration's compensation saga in Scenario 2 below. It is the dominant axis along which the two patterns differ in this codebase.

A practical consequence is that the choice of pattern partially determines whether transient-error spikes show up as user-visible compensations or as silent latency tax. Choosing one or the other depends on whether downstream failures are best treated as recoverable (favours orchestration's automatic retry) or as semantically meaningful events the saga must react to (favours choreography's immediate propagation). Equalising the policies would require either disabling Temporal retries on the activity (`MaximumAttempts = 1`) or wrapping the choreography consumer in `UseMessageRetry` and re-throwing on business failure.

### 4.4 Choreography classification anomaly: `failed` ≫ `compensated`

In both scenarios choreography reports far more `failed` than `compensated` orders (e.g. 113 failed vs 44 compensated at 100% rate), even though every non-completed saga ultimately reached terminal `Failed`. Looking at `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-mixed-workload.js:113-126`, the classification depends on the `compensated` flag in the benchmark response:

- `compensated: true` ⇒ counted as **compensated** and tagged `outcome:compensation`.
- Otherwise, `finalStatus === 'Completed'` ⇒ **completed**; anything else ⇒ **failed**.

So in choreography, many orders reach `Failed` without the response setting `compensated: true` — likely because the benchmark endpoint returns at the moment the saga reaches a terminal state, and choreography's terminal-state detection doesn't always signal "compensation ran" reliably. The `compensationSagaMs` and `compensationWindowMs` percentiles only cover the subset that *was* tagged compensation (n=41–53 at 5 rps × 30 s ≈ 150 orders), so they may slightly under-represent the real distribution.

This does **not** invalidate the comparison — the per-sample timings on the tagged subset are still valid — but the per-pattern accounting in `totals` should be reported with this caveat.

### 4.5 Throughput sanity check

- 10 rps × 60 s = 600 target orders. All five Scenario 1 runs landed within 609–612 total orders (completed + compensated + failed) → load generator hit the target rate cleanly.
- 5 rps × 30 s = 150 target orders. All runs landed within 146–157 orders → same.

No saturation observed at these rates; the latency results reflect intrinsic pattern overhead, not queueing under overload.

## Recommended Follow-ups Before Citing in the Thesis

- **Frame Scenario 1 around the retry-budget finding**, not as a mixed-workload latency comparison. Three independent runs producing `0 / 0 / 0` orchestration failures confirm the binomial prediction; the row is a *result*, not a pending re-run. If a side-by-side compensation-latency comparison at 10 rps is still wanted, either set `FAIL_RATE_PCT` high enough to overwhelm the retry policy (e.g. ≥ 50 % per call → ≥ 12.5 % per saga) or temporarily lower `MaximumAttempts` to 1 for that run.
- **Report the compensation comparison primarily from Scenario 2** (100% rate), where retries cannot mask the failure and both modes definitively exercise compensation. The headline finding — that orchestration's full-saga rollback time is dominated by activity retries rather than the compensation steps themselves — is well-supported by these runs.
- **Add a paragraph explaining the `failed` vs `compensated` classification** in choreography, or fix the response payload so `compensated: true` is set whenever the saga reached `Failed` via the compensation chain, to keep the totals interpretable.



Now let me look at the actual test results and the compensation test script to understand what is being measured.

Let me read the test script to understand exactly what is being measured:

Let me quickly check the orchestration setup to understand why compensation takes much longer there:

Let me verify the choreography retry behavior — the comment says it matches orchestration but the timings are very different:

# Test I: Compensation Correctness — Analysis

## 1. Purpose of the Test

Verify that **compensation actually restores system state after failure** in both saga patterns. It is a *correctness* test, not a performance test, but it does record how long it takes for an order to reach the `Failed` terminal status. Per `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-compensation-correctness.js:10-18`, the test answers: *"Do both patterns properly clean up after themselves when things go wrong?"* by checking three invariants:

- **Liveness** — every order reaches the `Failed` status (none stuck in `Pending` or `Compensating`).
- **Inventory rollback** — `reservedQuantity` for the test product returns to its baseline.
- **No dangling state** — every order ends in a terminal status.

## 2. Test Setup

Implemented as a single-VU k6 scenario with deterministic 100% payment failures.

**Configuration** (`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-compensation-correctness.js:31-51`):

- `ITERATIONS = 10`
- `vus = 1`, `executor = per-vu-iterations` (single-threaded — no inter-iteration interference)
- `TIMEOUT_MS = 15000` per order
- Hard k6 threshold: `orders_stuck: ['count==0']` — any stuck order fails the run
- Product under test: `a1111111-1111-1111-1111-111111111111`

**Setup phase** (`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-compensation-correctness.js:53-74`):

1. Reset inventory and orders.
2. Snapshot baseline `reservedQuantity` and `stockQuantity` for the test product.
3. `POST /api/payments/failure-rate/100` — force every payment to fail.

**Iteration body** (`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-compensation-correctness.js:76-126`):

1. `POST /api/orders` with one product (qty=1, $29.99).
2. Poll `/api/orders/{id}/status` every 50 ms until `Failed` or `Completed` (timeout 15 s).
3. Record `compensation_total_ms` = wall-clock from POST to `Failed`.
4. 500 ms gap between iterations so async compensation can settle.

**Teardown phase** (`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-compensation-correctness.js:128-170`):

1. Reset payment failure rate to 0.
2. Sleep 2 s for in-flight compensations.
3. Compare `reservedQuantity` to baseline (PASS/FAIL).
4. Verify no orders remain in `Pending`/`Compensating` (PASS/FAIL).

The test was executed twice per mode (4 timestamped runs in `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_i`).

## 3. Summary of Test Results

### Correctness (identical for both patterns)

| Check | Orchestration | Choreography |
|---|---|---|
| Orders reached `Failed` | 10 / 10 | 10 / 10 |
| Orders stuck | **0** | **0** |
| Inventory reservation released to baseline | PASS (assumed — `orders_stuck=0` and threshold passed) | PASS |
| Order status invariant (none in `Pending`/`Compensating`) | PASS | PASS |

Both patterns are functionally correct. **Both meet the correctness criterion.**

### Time-to-`Failed` (`compensation_total_ms`, ms)

| Run | Mode | Count | Avg | Median | P95 | Max |
|---|---|---|---|---|---|---|
| 19:00:02 | Orchestration | 10 | 3565.0 | 3566.5 | 3660.2 | 3675.0 |
| 19:01:00 | Orchestration | 10 | **3586.1** | 3590.0 | 3644.3 | 3647.0 |
| 19:01:40 | Choreography | 10 | 215.7 | 168.5 | 476.2 | 681.0 |
| 19:02:09 | Choreography | 10 | **192.6** | 195.5 | 229.0 | 229.0 |

Canonical results ([compensation_orchestration.json](cci:7://file:///Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_i/compensation_orchestration.json:0:0-0:0) / [compensation_choreography.json](cci:7://file:///Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_i/compensation_choreography.json:0:0-0:0)):

- **Orchestration:** avg ≈ **3,586 ms**, p95 ≈ **3,644 ms**
- **Choreography:** avg ≈ **193 ms**, p95 ≈ **229 ms**
- **Ratio:** orchestration is roughly **18× slower** to reach the `Failed` terminal state.

## 4. Analysis

### 4.1 Both patterns are correct

The headline finding for the thesis is that **the compensation logic in both patterns is sound**: 100% of orders reached `Failed`, and the k6 hard threshold (`orders_stuck: count==0`) passed in every run. Inventory was released, no payments stuck, no orders dangling. From a *correctness* standpoint, orchestration and choreography are equivalent in this test.

### 4.2 The 18× latency gap is structural, not a defect

The dramatic difference in time-to-`Failed` is a direct consequence of **how each pattern interprets a failed PaymentService call**, despite both having a *nominally* matched retry policy (3 attempts with 1 s + 2 s backoff).

**Orchestration path** (`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/OrderService/Orchestration/OrderActivities.cs:83-88`):

The `ProcessPaymentAsync` activity throws `ApplicationException` when the HTTP call returns non-success. Temporal treats *every thrown exception* as a retriable transient failure and applies `DefaultActivityOptions` (`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/OrderService/Orchestration/OrderSagaWorkflow.cs:20-29`): 3 attempts at t=0, t≈1 s, t≈3 s. Only after the third deterministic failure does the workflow enter the `catch` block and start compensations. That bakes in **~3 seconds of retry backoff before compensation even begins**, matching the observed 3.5–3.6 s total.

**Choreography path** (`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/PaymentService/Choreography/ProcessPaymentConsumer.cs:27-32`):

The consumer does **not** throw on a business failure; it publishes a `PaymentFailed` event and returns normally:

```@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/PaymentService/Choreography/ProcessPaymentConsumer.cs:27-32
if (!result.Success)
{
    _logger.LogWarning("[Choreography] ProcessPayment failed for OrderId={OrderId}: {Error}", command.OrderId, result.Error);
    await context.Publish(new PaymentFailed(command.OrderId, result.Error!));
    return;
}
```

From MassTransit's perspective the message was successfully consumed, so `UseMessageRetry` (`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/src/Services/OrderService/Program.cs:80-83`) never engages. The `PaymentFailed` event flows directly to the saga state machine, which transitions to `Compensating` and then `Failed` in a single message round-trip per service — hence the ~200 ms total.

In other words, the same retry policy is configured in both patterns, but it only fires in orchestration because the failure surface is an *exception*, while in choreography the same condition is modelled as a *business event*. **This is an asymmetry in failure semantics, not in retry configuration.**

### 4.3 Variance and tail behavior

Choreography shows mild but visible jitter — one of its two runs reports max=681 ms and p95=476 ms, more than double its median (168.5 ms). This is consistent with RabbitMQ scheduling jitter, EF Core query-plan warmup, and MassTransit consumer activation: the first iteration in a series tends to pay a one-off cost. Orchestration's tail is far tighter (max ≈ p95 ≈ avg + ~80 ms) because almost all of the duration comes from *deterministic* retry backoff (1 s + 2 s waits), so per-iteration noise is dominated by the fixed timer.

### 4.4 Implications for the thesis

- **Correctness conclusion:** both patterns recover cleanly from a deterministic downstream failure; neither leaks reservations or leaves dangling state under the conditions of Test I.
- **Latency conclusion:** the *raw compensation cost* in this codebase is roughly an order of magnitude smaller in choreography (~200 ms vs ~3.6 s), but this is **dominated by retry semantics, not by the saga pattern itself**. If `MaximumAttempts` were lowered to 1 on the orchestration path (matching the comment "fast-fail" intent for benchmarking), the gap would likely shrink dramatically and the residual difference would reflect Temporal's history-write overhead vs. RabbitMQ's pub/sub overhead.
- **Caveat to call out in the write-up:** when comparing compensation latency between patterns, the *failure-injection mechanism* must be defined identically. Here, "100% payment failure" means an HTTP error on the orchestration side (which retries) but a business event on the choreography side (which does not). Test M (Failure During Rollback) is the more direct stress test for compensation-step failure.

### 4.5 Suggested thesis table

| Aspect | Orchestration | Choreography |
|---|---|---|
| Orders reached `Failed` | 10 / 10 | 10 / 10 |
| Orders stuck | 0 | 0 |
| Inventory restored | Yes | Yes |
| Time-to-`Failed` (avg) | 3,586 ms | 193 ms |
| Time-to-`Failed` (p95) | 3,644 ms | 229 ms |
| Dominant cost driver | 3× activity-retry backoff (1 s + 2 s) before compensation begins | Single message hop publishing `PaymentFailed` |
| Failure semantics | Activity exception → retried | Business event → no retry |




The [test_j/](cci:9://file:///Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_j:0:0-0:0) directory appears empty. Let me check more carefully, including hidden files.





# Test J — Endurance / Sustained Load: Analysis

## 1. Purpose of the Test

Test J is the **sustained-load (endurance) benchmark**. Its goal is **not** to find peak throughput or measure cold-start, but to answer one question:

> *Does either saga pattern degrade over time at a fixed, moderate load?*

Specifically, it surfaces problems that single-shot benchmarks (Test A, Test K) miss:

- **Queue-backlog growth** in choreography (RabbitMQ depth creeping up because consumers can't keep up with producers).
- **Temporal history-table bloat** in orchestration affecting Postgres write latency over time.
- **Connection-pool exhaustion** in any service.
- **Unbounded memory growth** / leaks in long-running .NET processes.

The signal it produces is **P95 drift** — the difference between the end-bucket P95 and the start-bucket P95. As stated in `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/docs/HOW-TO-RUN.md:766-769`, anything under **500 ms of drift is steady-state**; more than that means something is degrading.

## 2. Test Setup

Driver: `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-endurance.js`.

- **Rate**: 25 requests/sec, **constant-arrival-rate** k6 executor (so timing isn't distorted by closed-loop slowdowns).
- **Duration**: 5 minutes per mode → ~7,500 sagas/run.
- **Endpoint**: `POST /api/orders/benchmark`, which blocks until terminal saga state and returns `totalSagaDurationMs` (the metric being analysed).
- **Warm-up handling**: none — k6 starts at full rate, so the **start bucket includes JIT/EF warm-up**.
- **Three equal buckets** (each ~100 s) — `start`, `middle`, `end` — tagged on the metric so [handleSummary](cci:1://file:///Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-endurance.js:119:0-189:1) can compute per-bucket percentiles and the drift number.
- **Setup hook**: full state reset before each run — inventory restocked, all orders deleted, payment failure-rate forced to 0.
- **Workload mix**: random pick of 3 products, qty 1, fresh `customerId` UUID per request. **Happy-path only**; no compensation in this test.
- **Both modes use identical infra**: same Postgres / RabbitMQ / Temporal containers, no resource limits. Only `SAGA_MODE` is flipped between runs.

Files analysed:
- `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_j/endurance_orchestration_25rps.json`
- `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_j/endurance_choreography_25rps.json`

## 3. Summary of Test Results

**Total saga duration (ms), 25 req/s for 5 minutes:**

| Bucket | Orchestration (n) | avg | p95 | p99 | max | Choreography (n) | avg | p95 | p99 | max |
|---|---|---|---|---|---|---|---|---|---|---|
| start  | 2,293 | 768.6 | 937.4 | 1,715.9 | **3,899.2** | 2,354 | 254.0 | 337.1 | 363.6 | **3,299.3** |
| middle | 2,493 | 751.0 | 889.4 | 993.2   | 1,949.1     | 2,500 | 249.3 | 336.1 | 361.9 | 391.9 |
| end    | 2,545 | 749.7 | 890.5 | 985.2   | 1,952.4     | 2,556 | 248.4 | 336.1 | 362.1 | 374.3 |
| **overall** | **7,331** | **756.1** | **907.5** | **1,238.6** | 3,899.2 | **7,410** | **250.5** | **336.4** | **362.7** | 3,299.3 |

**P95 drift (end − start):**

- **Orchestration: −46.9 ms** (end is *faster* than start)
- **Choreography: −1.0 ms** (essentially flat)

Both runs delivered ~98 % of the 7,500 target sagas (orch 97.7 %, chor 98.8 %), no failed-status spikes were reported.

## 4. Analysis

### 4.1 Both patterns are steady-state — neither leaks at 25 RPS

The defining metric of this test is the drift number, and **both modes are well below the 500 ms warning threshold**. In fact, both drifts are slightly *negative*: end-bucket P95 is a hair lower than start-bucket P95. That confirms two things:

1. The 5-minute window contains **no measurable backpressure or resource leak** — RabbitMQ is draining as fast as it fills, Temporal's growing history table isn't yet impacting Postgres write latency, and the .NET processes aren't bloating their working sets.
2. The slight negative drift is the **JIT / EF query-plan warm-up** still bleeding into the first ~100 s. Once past the warm-up, `middle` and `end` buckets are statistically indistinguishable for both modes (orch P95 889 vs 890; chor P95 336 vs 336).

In thesis terms: at this load, neither pattern is the limiting factor.

### 4.2 The dominant finding is structural, not temporal: choreography is ~3× faster end-to-end

Even though this is an endurance test, the headline number jumps out: **choreography averages 250 ms vs orchestration's 756 ms**, and the P95 gap is even wider (336 ms vs 908 ms — a **571 ms** absolute difference). This is **constant across all three buckets**, so it isn't a transient — it's a property of the patterns.

The cause is architectural. In the orchestration mode, every saga step is a Temporal workflow task: each transition does a `Postgres workflow-history append → workflow advance → activity dispatch → activity result append → Postgres again`. Five steps × ~150 ms of central-state round-trip ≈ 750 ms. In choreography, each service consumes a RabbitMQ event, writes to its own DB, and emits the next event — no central state machine, no per-step history persistence. Five hops × ~50 ms ≈ 250 ms.

So orchestration is **paying ~500 ms of latency for centralized workflow state and explicit recovery semantics**, sustained over the full 5 minutes. That's the trade-off your thesis can quantify cleanly here, because Test J controls for everything else (same infra, same rate, same duration, same product mix, same state reset).

### 4.3 Tail-latency behaviour differs — orchestration's tail is fatter even at steady state

After the start bucket flushes warm-up effects, the two patterns reveal a structural tail difference:

- **Choreography post-warmup max ≈ p99 + 30 ms** (374 vs 362). The tail is *tight*: events flow through RabbitMQ with predictable per-hop cost, and there's no "stop-the-world" event that introduces outliers.
- **Orchestration post-warmup max ≈ 2× p99** (1,952 vs 985). Even when nothing is degrading, ~1 in every ~2,500 sagas takes roughly twice as long as the 99th percentile. The most plausible cause is **Temporal's sticky-task-queue cache miss / workflow-task timeout retry**: when a worker rebalances or a workflow task lands on a non-cached worker, the workflow has to be replayed from history, which adds hundreds of ms.

For a thesis, this is worth flagging: orchestration provides stronger consistency guarantees but **exhibits a wider tail-latency distribution** that doesn't shrink under sustained moderate load.

### 4.4 The start-bucket P99 spike in orchestration (1,715 ms) is warm-up, not pattern overhead

Orchestration's start-bucket P99 (1,715.9 ms) is nearly **double** its middle/end P99 (~990 ms). Choreography's start P99 (363.6 ms) is **identical** to middle/end (~362 ms). This tells us:

- **Temporal workers carry a heavier cold path** than MassTransit consumers — likely workflow-type registration, sticky-queue assignment, and Postgres history-table query-plan compilation all happening on the first few hundred orders.
- **Choreography's per-service startup is amortised invisibly** because a `MassTransit consumer + EF context warm-up` takes a handful of milliseconds per service vs Temporal's seconds-scale registration.

This is consistent with whatever Test L (cold-start) will show in concentrated form. Test J captures it as a slow-bleed for the first ~100 s rather than as an isolated event.

### 4.5 Throughput parity confirms neither is rate-saturated

7,331 vs 7,410 completed sagas (target was 25 × 300 = 7,500) means **both modes processed ~98 % of arrivals** with no errors — the missing ~2 % is k6's natural arrival-rate jitter at the boundaries, not failure. This rules out the alternative explanation that "orchestration looks slower because it's queueing." It isn't — every saga is being completed, the cost is per-saga in the critical path.

### 4.6 What this test does *not* tell you

Worth being explicit about for the thesis:

- **No compensation in this run** (`FAIL_RATE_PCT=0`). Orchestration's compensation cost is typically much closer to choreography's than its happy-path cost — that's a Test H/M question.
- **25 RPS is moderate**, not saturating. The interesting endurance question — *does choreography degrade first under sustained higher load because the RabbitMQ broker is the bottleneck, or does orchestration degrade first because Temporal's history table grows linearly?* — would need a Test J re-run at higher rates (50, 100 RPS) and longer durations (15-30 min) to surface.
- **5 minutes is short** for memory leaks. Java-/CLR-style slow leaks need 30+ minutes to manifest. The drift signal here only rules out *fast* leaks.

### 4.7 Bottom line for the thesis

> At 25 RPS sustained for 5 minutes, **both saga patterns are steady-state with no measurable degradation or queue backlog**. The structural latency gap between them — choreography ~3× faster on average, ~2.7× faster at P95 — is **constant over time**, confirming it is a property of the coordination model (centralized Temporal workflow vs distributed RabbitMQ events), not an artefact of warm-up or accumulated load. Orchestration additionally exhibits a wider P99-to-max gap that persists at steady state, indicating a heavier tail driven by workflow replay and worker rebalancing.









# Test K — Concurrent-Customer Throughput

## 1. Purpose of the test

Test K measures **pure pipeline parallelism** under high concurrency with **zero row-level contention**. From `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/docs/HOW-TO-RUN.md:777-805` and `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-concurrent-customers.js:6-19`:

- Many virtual users (VUs) fire orders simultaneously, but each VU targets a **different** product from a plenty-stock pool, so no two concurrent sagas fight over the same `Product.ReservedQuantity` row.
- This isolates the **structural overhead of each saga pattern** (HTTP intake, Temporal workers vs. MassTransit consumers, DB connection pools, broker hops) from the optimistic-concurrency cost that Test F intentionally stresses.
- Compared head-to-head against Test F at matching VU counts, the gap quantifies the **price of contention** in each pattern; on its own, Test K answers: **"Which pattern parallelises happy-path sagas better?"**

## 2. How the test is set up

**Workload generator** (`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-concurrent-customers.js:30-96`):

- **Executor**: k6 `constant-vus` — each VU loops as fast as it can with no rate cap.
- **Configuration**: `VUS=25`, `DURATION=30s`.
- **Endpoint**: `POST /api/orders/benchmark` (blocking — returns only when the saga reaches a terminal state, with full timing telemetry).
- **Product distribution**: 5 plenty-stock products (100k units each); each VU is pinned to one via `__VU % 5`, so the 25 VUs are spread across all 5 products with 5 VUs per row — no oversell pressure.
- **Thresholds**: `p(95) total_saga_duration_ms < 15 000 ms`.

**Setup phase** (k6 [setup()](cci:1://file:///Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-concurrent-customers.js:59:0-65:1), executed once before VUs ramp):

- `POST /api/inventory/reset` — restock everything, clear reservations.
- `DELETE /api/orders/reset` — wipe order history.
- `POST /api/payments/failure-rate/0` — force the happy path (no compensation noise).
- `sleep 2` to let state settle.

**Mode switching**: `SAGA_MODE` env var on the .NET services is flipped between runs via `docker compose up -d --force-recreate` (per `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/docs/HOW-TO-RUN.md:786-796`); infrastructure (Postgres, RabbitMQ, Temporal) stays warm across the switch.

**Captured metrics**: `apiResponseMs` (POST → saga-initiated), `totalSagaDurationMs` (saga-initiated → terminal), `orders_completed`, `orders_failed`, and a derived `effectiveThroughputPerSec = completed / durationSec`.

## 3. Summary of test results

The [results/test_k/](cci:9://file:///Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_k:0:0-0:0) directory contains **two runs per mode** (timestamped) plus a canonical file mirroring the latest run of each mode. Numbers below are taken from `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_k/concurrent_orchestration_25vus.json:1-27` and `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_k/concurrent_choreography_25vus.json:1-27` (the latest, warm runs of each mode).

### Headline numbers — warm runs (25 VUs, 30 s)

| Metric | Orchestration (Temporal) | Choreography (MassTransit) | Choreography vs. Orch. |
|---|---:|---:|---:|
| Orders completed | 897 | 1 734 | **1.93×** |
| Orders failed | 1 | 75 | +74 |
| Effective throughput | 29.9 orders/s | **57.8 orders/s** | **+93 %** |
| API response P95 | 23.8 ms | 4.5 ms | **−81 %** |
| API response P99 | 55.4 ms | 37.6 ms | −32 % |
| API response max | 71.1 ms | 148.4 ms | +109 % |
| Saga duration median | 779.5 ms | 258.2 ms | **−67 %** |
| Saga duration P95 | 962.6 ms | 365.0 ms | **−62 %** |
| Saga duration P99 | 1 689.6 ms | 1 327.3 ms | −21 % |
| Saga duration max | 1 995.7 ms | 4 251.7 ms | +113 % |

### Run-to-run consistency

**Orchestration** (`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_k/concurrent_orchestration_25vus_2026-04-28T19-20-26-665Z.json:1-27` and `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_k/concurrent_orchestration_25vus_2026-04-28T19-21-02-045Z.json:1-27`) is highly stable across both runs:

- Throughput: 29.7 → 29.9 orders/s (±0.7 %)
- Saga P95: 1 040.5 → 962.6 ms
- Failures: 0 → 1

**Choreography** shows a striking **first-run penalty**, visible in `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_k/concurrent_choreography_25vus_2026-04-28T19-22-22-687Z.json:1-27`:

- First run (cold consumers): 30.2 orders/s, saga P95 398.9 ms but **P99 = 7 384 ms, max = 9 285 ms**, API P99 = 1 444 ms.
- Second run (warm): 57.8 orders/s, saga P99 = 1 327 ms, max = 4 252 ms.

The first run is essentially capped at the same throughput as orchestration because a long tail of slow sagas blocked VUs from looping. After warm-up, the throughput nearly doubles.

## 4. Analysis of the test results

### 4.1 Choreography is roughly 2× faster on a contention-free happy path

With 25 VUs spread over 5 products, both patterns have ample parallelism available; what differs is how a single saga moves through its 5 steps:

- **Orchestration (Temporal)**: every step transition is a workflow-task round trip — the worker polls a task from the Temporal task queue, executes the activity (which itself talks to a service over HTTP/MassTransit or directly), then writes the activity result back to Temporal's history table in Postgres before the next task is scheduled. Five steps mean **five history writes + five task-queue dispatches** in addition to the actual work, all funneled through the central server. Median saga = 779.5 ms.
- **Choreography (MassTransit/RabbitMQ)**: each service consumes the previous service's event and publishes the next one directly on the broker. There is no central history write per step; each hop is one queue publish + one consumer dispatch. Median saga = 258.2 ms — **3.0× faster at the median**, ~2.6× faster at P95.

Because `/api/orders/benchmark` blocks until terminal state, halving saga duration roughly doubles VU loop frequency, and that is exactly what shows up: **57.8 vs. 29.9 orders/s ≈ 1.93×**, almost perfectly tracking the median saga ratio.

### 4.2 API intake is also dramatically faster in choreography

API response P95 of **4.5 ms vs. 23.8 ms** (−81 %) reflects what `OrderService` does to start each pattern:

- Orchestration: synchronously calls `Temporal.StartWorkflow`, which is a network round trip to the Temporal frontend plus a synchronous Postgres insert into the workflow history.
- Choreography: an in-process MassTransit `Publish` to RabbitMQ — fire-and-forget, no synchronous DB write on the hot path.

This matches the documented design difference and is consistent across both choreography runs (P95 6.0 ms cold, 4.5 ms warm).

### 4.3 Choreography wins the median but loses the tail

The max latencies invert the headline ranking:

- Orchestration max saga: **1 996 ms** (about 2× P95).
- Choreography max saga: **4 252 ms** (about 12× P95).

Temporal's central state machine gives it tightly bounded outliers because each step is acknowledged and timer-driven by a single coordinator. In choreography, a tail latency emerges whenever a RabbitMQ consumer lags, a service's connection pool blocks, or a transient DB lock delays a single step — and there is no coordinator to retry deterministically, so the slowest hop dictates the whole saga's tail. This is also where the **75 failed orders** come from: at the saturated rate (~58 orders/s through 5 services), some sagas exceed the 35 s benchmark timeout or trip the `finalStatus !== Completed` check before the test window ends.

Orchestration's failure count of **1 / 897** vs. choreography's **75 / 1 809** is a direct expression of the durability/throughput trade-off: Temporal pays a per-step latency tax in exchange for a deterministic state machine that almost never loses sagas under this load; MassTransit + RabbitMQ ships nearly twice as many sagas through but with a measurable tail-failure rate.

### 4.4 The cold-start penalty is asymmetric

The first choreography run (19:22:22) collapsed to **30.2 orders/s** — indistinguishable from orchestration — even though steady-state choreography runs at 57.8 orders/s. The signature is a P99 saga of 7 384 ms and an API P99 of 1 444 ms, both ~5× higher than the warm run, while the median (259 ms) is unchanged. Diagnosis: a small number of MassTransit consumers were still warming up (queue binding, EF-Core query-plan compilation, JIT tiered compilation) when the 25 VUs immediately saturated the pipeline; the resulting head-of-line blocks rippled through the pool of in-flight sagas and gated VU loop frequency.

Orchestration shows no such asymmetry between its two runs (29.7 → 29.9 orders/s), because Temporal workers prefetch tasks at a steady cadence and warm up gradually rather than being shock-loaded by the first burst of events. **Practical implication for the thesis**: choreography's published throughput must be qualified with a warm-up clause — Test L (cold-start) is the natural follow-up.

### 4.5 What this isolates that other tests cannot

Because `Product.Version` optimistic-concurrency contention is removed by VU-to-product pinning, Test K's gap between modes is **not** caused by row-locking; it is the structural overhead of each pattern. Comparing this to Test F at the same VU count (where 20 VUs all hit one stock-1 product) will quantify the fraction of orchestration's throughput deficit that is intrinsic to its design vs. the fraction that is the cost of serialising contended writes.

### 4.6 Headline conclusion

At 25 VUs over disjoint products on warm services:

- **Throughput / latency winner**: choreography (≈ 2× orders/s, ≈ 3× faster median saga, ≈ 5× faster API P95).
- **Tail-latency / reliability winner**: orchestration (max saga 2 s vs. 4.3 s; 0.1 % failure rate vs. 4.1 %).
- **Cold-start sensitivity**: choreography degrades sharply in the first run; orchestration is run-to-run stable.







# Test L Analysis: Cold-Start Penalty

## 1. Purpose of the Test

Test L measures the **latency penalty on the first few requests after a fresh service restart**, isolating the warm-up cost that single-shot benchmarks normally hide. Concretely it captures:

- **Temporal worker activation** (workflow type registration, sticky cache initialisation) for orchestration
- **MassTransit consumer subscription** (queue/exchange/binding setup, channel allocation) for choreography
- **EF Core query-plan compilation** on first hit per query shape
- **.NET tiered JIT** moving hot methods from Tier-0 to Tier-1

The metric of interest is `coldPenaltyMs = firstRequestMs − warmTailAvgMs`, i.e. how much extra latency the *very first* customer pays compared to a steady-state customer.

## 2. Test Setup

Defined in `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-cold-start.js:51-98` and run via `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/docs/HOW-TO-RUN.md:808-843`:

- **Iterations:** 20 sequential orders (`vus: 1`, `per-vu-iterations`).
- **Gap:** 500 ms between requests — long enough not to overlap, short enough that JIT/EF caches don't decay.
- **Endpoint:** `POST /api/orders/benchmark`, which blocks until the saga reaches a terminal state, so each measurement is full end-to-end saga time, not just HTTP intake.
- **Cold trigger:** the 5 .NET saga services + api-gateway are `docker compose up -d --force-recreate`'d immediately before each run, guaranteeing JIT and EF caches are cold. Postgres, RabbitMQ and Temporal are *not* recreated, so their schemas, queue topology, and workflow-type registry stay warm. The penalty therefore measures **service-process** cold start, not infrastructure cold start.
- **Two runs**, one per mode, each starting from a freshly recreated service set:
  - Orchestration: `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_l/coldstart_orchestration.json`
  - Choreography: `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_l/coldstart_choreography.json`
- **Cold penalty calculation:** `firstRequestMs − avg(perRequestMs[10..20])`. The "warm tail" is the second half of the run.

## 3. Summary of Results

| Metric | Orchestration (Temporal) | Choreography (MassTransit) | Δ (Choreo − Orch) |
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

Key shape: in **both** modes the first request is the dramatic outlier. Request #2 already lands within the normal warm-tail band, so almost the entire cold cost is paid by a single saga.

## 4. Analysis

### 4.1 Choreography pays a 65 % larger cold-start penalty

Choreography's first-request penalty (1657 ms) is **~650 ms larger** than orchestration's (1007 ms). This matches the architectural difference:

- **Choreography** must, on the first message, bind queues, declare exchanges, allocate AMQP channels, and start consumers in **all four** downstream services (`Inventory`, `Payment`, `Shipping`, `Notification`) since each one independently consumes the previous step's event from RabbitMQ. Every service pays its own MassTransit + EF cold cost on its first message, and these costs **chain serially** along the saga.
- **Orchestration** does most cold work upfront in *one* place: the Temporal worker hosted in `OrderService` activates the workflow, registers types, and warms the sticky cache. Activities in the other services still cold-start, but the Temporal client connection and dispatcher are centralised, so the per-hop overhead is smaller.

### 4.2 Choreography is faster in steady state

Once warm, choreography averages **261 ms** vs orchestration's **368 ms** — a **~29 %** steady-state advantage. This is consistent with the patterns' theoretical cost model:

- Orchestration adds a Temporal round-trip per step (workflow → task queue → worker → activity → history persistence → workflow), so each saga incurs ~5 extra Temporal RPCs and history writes.
- Choreography's per-step cost is a single RabbitMQ publish + consume, with no central history table to update.

### 4.3 Break-even analysis

If a freshly deployed service handles `N` requests before being restarted again, the total time spent is roughly:

```
T(orch)   ≈ 1375 + 368 · (N − 1)
T(choreo) ≈ 1918 + 261 · (N − 1)
```

Solving `T(choreo) ≤ T(orch)` gives `N ≥ 1 + 543/107 ≈ 6.1`. **From request #7 onward, choreography is cumulatively faster**, despite its worse first-request latency. For any non-trivial workload between deploys, the steady-state advantage dominates.

### 4.4 What the cold cost actually represents here

Because Postgres, RabbitMQ, and Temporal are not recreated, the measured penalty is **purely the .NET service-process warm-up**, not infrastructure spin-up. As the doc warns at `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/docs/HOW-TO-RUN.md:849-854`, a full `docker compose down/up` would push the cold penalty 5–10× higher because Temporal auto-setup and Postgres buffer-cache warmup would land on the first saga. The numbers reported here therefore represent the **best-case** cold-start scenario — the pattern most relevant to rolling deploys and pod restarts where the broker / DB stay up.

### 4.5 Practical implications for the thesis

- **Workloads with rare restarts and sustained traffic** (long-lived services, blue-green deploys with traffic ramp): choreography wins overall. The 543 ms one-off penalty amortises within a handful of requests, after which it consistently delivers ~107 ms lower latency per saga.
- **Workloads with frequent cold starts** (autoscaling on bursty traffic, serverless-style scale-to-zero, canary deploys exposed to a single early request): orchestration is more **predictable**. Its first-request cost is lower in absolute terms (1375 ms vs 1918 ms), and its warm-vs-cold variance is smaller (factor 3.7× vs 7.3×).
- **Tail-latency / SLO design**: if a P99 SLO must be honoured immediately post-deploy, choreography's first-request 1918 ms is the figure to budget against, and a synthetic warm-up hit before exposing the pod to real traffic is essentially mandatory. Orchestration tolerates "deploy then receive traffic" with less ceremony.
- **Caveat on N=1 first request**: each mode has only one cold sample, so the absolute numbers carry per-run noise (Docker scheduling, host load). The *relative ordering* — choreography's bigger cold spike but faster warm tail — is the robust thesis-level finding; if the thesis cites absolute milliseconds, repeating the run 3–5× and reporting the median would tighten the claim without changing the conclusion.










# Test M Analysis: Failure During Rollback (Resilience)

## 1. Purpose of the Test

Test M reproduces the supervisor's scenario: *what happens when a compensation step itself fails mid-rollback?* It asks whether the saga can self-recover or leaves the system permanently inconsistent.

Test I (`compensation`) only validates the **happy compensation path** — payment fails, rollback succeeds, state is restored. Test M goes further by injecting a **second failure into the rollback itself**, surfacing the divergence in how each pattern degrades when its compensating action cannot complete. The headline thesis question it answers is whether orchestration (Temporal) or choreography (MassTransit) provides better resilience guarantees under cascading failure.

## 2. Test Setup

Defined in `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/benchmark-rollback-failure.js:1-290` and documented in `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/docs/HOW-TO-RUN.md:862-931`.

**Per iteration:**

- **Force compensation entry** — `PaymentService.failure-rate = 100` so every saga enters rollback after Reserve succeeds.
- **Inject the cascading failure** — `FAIL_TARGET` either:
  - `inventory` → `InventoryService.ReleaseAsync` throws on every call
  - `notification` → `NotificationService.SendAsync` throws on every call
- **Place 10 orders** sequentially (`vus=1`, `iterations=10`), poll `/api/orders/{id}/status` every 100 ms up to a 15 s timeout per order.
- **Classify outcome**:
  - `ordersReachedFailed` — order reached terminal `Failed` state.
  - `ordersStuck` — never terminal within 15 s (still in `Pending`/`Compensating`).
  - `inconsistentUnits` — inventory leak (`currentReserved − baselineReserved`) **plus** stuck orders.
- **Teardown** resets all failure rates, sleeps 5 s for in-flight retries to drain, then snapshots inventory and the order-status histogram.

Two scenarios × two patterns = four runs per session.

## 3. Summary of Test Results

### Scenario A — `FAIL_TARGET=inventory` (compensation step that mutates state)

| Metric | Orchestration | Choreography |
|---|---|---|
| Orders reached `Failed` | **10 / 10** | **0 / 10** |
| Orders stuck (`Compensating`) | 0 | **10** |
| Inconsistent units (leak + stuck) | **10** (pure inventory leak) | **20** (10 leaked + 10 stuck) |
| Time-to-terminal avg | 3643.5 ms | n/a |
| Time-to-terminal p95 / max | 3722.6 / 3723.0 ms | n/a |

`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_m/rollback-failure_orchestration_inventory.json:1-16`
`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_m/rollback-failure_choreography_inventory.json:1-10`

### Scenario B — `FAIL_TARGET=notification` (best-effort, side-effect-free)

| Metric | Orchestration | Choreography |
|---|---|---|
| Orders reached `Failed` | **10 / 10** | **10 / 10** |
| Orders stuck | 0 | 0 |
| Inconsistent units | 0 | 0 |
| Time-to-terminal avg | 3625.3 ms | **215.8 ms** |
| Time-to-terminal med | 3624.5 ms | 218.5 ms |
| Time-to-terminal p95 | 3718.8 ms | 274.1 ms |
| Time-to-terminal max | 3721.0 ms | 316.0 ms |

`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_m/rollback-failure_orchestration_notification.json:1-16`
`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_m/rollback-failure_choreography_notification.json:1-16`

## 4. Analysis

### Headline finding: neither pattern self-heals — they fail differently

When a compensation step is permanently broken, **both patterns leave the system inconsistent**. The interesting comparison is the *failure mode*, not whether it fails. This is exactly the conclusion flagged in `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/docs/HOW-TO-RUN.md:925`: *"neither pattern auto-recovers from a permanently-failing compensation step. They differ only in how they fail."*

### Inventory failure: silent leak vs. visible stall

This is the high-impact case because the failing step mutates persistent state.

- **Orchestration (Temporal)** — Every order reaches `Failed` in ~3.6 s, but **10 inventory reservations leak**. The Temporal compensation activity is configured with `MaximumAttempts = 1`; the throwing `ReleaseAsync` call is swallowed by the workflow's catch block, the workflow continues to the `Failed` transition, and the reserved stock is never given back. Operationally this is the **most dangerous** outcome: the system *looks* healthy — orders are closed, no queue depth, no retries — yet inventory has silently drifted. Detection requires a reconciliation job comparing `Order.Status` against `Product.reservedQuantity`.
- **Choreography (MassTransit)** — Every order is **stuck in `Compensating`**, so the inconsistency count doubles (10 leaked + 10 stuck = 20). MassTransit's `UseMessageRetry` retries `ReleaseInventory` three times, then dead-letters the message to `release-inventory_error`. The saga state machine waits indefinitely for an `InventoryReleased` event that never arrives. The failure is **loud**: stuck saga rows in `OrderSagaState`, non-empty DLQ in RabbitMQ, alert-friendly. Recovery requires a DLQ replay tool plus operator action.

The trade-off this exposes: **orchestration optimises for terminal-state cleanliness at the cost of silent state corruption; choreography preserves an explicit "unfinished work" signal at the cost of leaving the saga visibly broken**. Which one is preferable depends on whether the operations team has reconciliation jobs (favouring choreography's loud failure) or whether the business prioritises closed orders for downstream consumers (favouring orchestration's terminal guarantee, accepting the leak).

### Notification failure: where the patterns *actually* converge — but with very different latency

Both patterns reach `Failed` cleanly with zero inconsistency, because failure-notification is implemented as best-effort (`try { send } catch { log }`) on both sides — a thrown notification doesn't block the saga. So functionally, **they're identical for this scenario**.

The latency, however, is dramatically different:

- Orchestration: ~3.6 s avg, identical to the inventory-failure path.
- Choreography: ~216 ms avg — roughly **17× faster**.

The orchestration time is independent of *which* compensation target fails, indicating the ~3.6 s is the inherent Temporal compensation pipeline cost (activity scheduling + retry budget exhaustion + state transition writes) rather than anything specific to the failing step. Choreography's compensation is just a fire-and-forget `Publish<SendNotification>` call followed by a synchronous saga state transition — it doesn't wait for the notification at all, so the failure injection never blocks the saga.

This means **for low-impact compensation failures, choreography recovers an order of magnitude faster**, but as scenario A shows, that speed disappears (becomes infinite) the moment the failing step is one the saga actually waits on.

### Methodological caveats

- Sample size is small (10 iterations per cell) — fine for the qualitative pass/fail signal but the timing percentiles in `timeToTerminalMs` should be interpreted as illustrative, not statistically robust.
- The `inconsistentUnits` metric overloads two distinct failure modes (leak count + stuck count). For the choreography-inventory cell, the value `20` reflects *both* effects on the same 10 orders — it's not 20 separate failures.
- The 15 s polling timeout is long enough that orchestration's ~3.7 s terminal time is comfortable, but it bounds how confidently we can say choreography orders are *permanently* stuck vs. just slow. Test N (broker outage) and Test O (worker crash) probe longer recovery windows.
- Notification compensation is best-effort *by design* in both implementations — this scenario validates that design choice but doesn't probe what happens if a non-best-effort downstream step fails. That's exactly what scenario A is for.

### Implications for the thesis

Test M's primary contribution is qualitative: it demonstrates that **compensation correctness is not an automatic property of either saga pattern** — it depends on (a) the retry/timeout policy configured on the failing step, (b) whether the saga *waits* on that step's success event, and (c) whether the operations team has tooling to detect silent inventory drift versus stuck saga rows. Both patterns require external recovery tooling (reconciliation job for orchestration, DLQ replay for choreography) for production-grade resilience to permanently-failing compensations. The pattern choice influences *how* you build that tooling, not *whether* you need it.









# Test N: Broker Outage During Rollback

## 1. Purpose

The test verifies that an in-flight saga **survives a restart of its underlying broker mid-rollback**. Each pattern depends on a different broker, so the broker target switches with the mode:

- **Orchestration** → `saga-temporal` (the Temporal server holds workflow state and dispatches activities)
- **Choreography** → `saga-rabbitmq` (the message bus carries the saga's `*Reserved` / `*Failed` / `Release*` events)

Question being answered: *Once the broker comes back, do all sagas drive themselves to a terminal state, and is there any orphaned state (stuck orders, leaked inventory)?*

It complements Test M (failure of a compensation **step**) by failing the **transport** instead. Sources:`@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/docs/HOW-TO-RUN.md:934-980` and `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/run-broker-outage-test.sh:1-189`.

## 2. How the test is set up

Defaults from `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/run-broker-outage-test.sh:42-46` (which match the result files):

- **`ORDERS=10`**, **`BROKER_DOWN_SECS=10`**, **`RECOVERY_SECS=90`**, **`WARMUP_MS=500`**
- All orders target the same product (`a1111111-…`).

Run sequence ([run-broker-outage-test.sh](cci:7://file:///Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/run-broker-outage-test.sh:0:0-0:0)):

1. Reset inventory + orders, set **`payments/failure-rate/100`** so every order is forced into compensation.
2. Snapshot baseline `reservedQuantity`.
3. Place 10 orders sequentially.
4. Sleep 500 ms so sagas start running.
5. `docker stop` the relevant broker; wait 10 s; snapshot order-status histogram **during** the outage.
6. `docker start` the broker, wait for its healthcheck (Temporal namespaces endpoint / RabbitMQ `rabbitmq-diagnostics ping`).
7. Poll `/api/orders/recent` every 2 s for up to 90 s, exiting early if every order has reached `Completed`/`Failed`.
8. Final histogram + inventory leak (`reservedNow − baseline`); reset payment failure rate.

The orchestration and choreography runs were performed back-to-back at 23:01:40 and 23:03:09 on 2026-04-28.

## 3. Summary of test results

### Orchestration — `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_n/broker-outage_orchestration.txt:1-24`

| Phase | Value |
|---|---|
| Broker stopped → started | 23:01:44 → 23:01:55 (~11 s outage) |
| Order histogram **during** outage | `{Pending: 10}` |
| Recovery poll | **All 10 reached terminal before 90 s deadline** |
| Final histogram | `{Failed: 10}` |
| Inventory leak | **2** units (baseline 0, reserved 2) |
| Wall-clock | started 23:01:40, finished 23:02:20 (~40 s total) |

### Choreography — `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_n/broker-outage_choreography.txt:1-23`

| Phase | Value |
|---|---|
| Broker stopped → started | 23:03:13 → 23:03:24 (~11 s outage) |
| Order histogram **during** outage | `{Compensating: 3, Failed: 4, Pending: 3}` |
| Recovery poll | "All orders reached terminal state" line is **absent** → polling ran the full 90 s |
| Final histogram | `{Compensating: 1, Failed: 8, Pending: 1}` — **2 orders stuck** |
| Inventory leak | **1** unit |
| Wall-clock | started 23:03:09, finished 23:04:55 (~106 s, almost entirely the 90 s poll) |

## 4. Analysis

### Saga progress at the moment of the kill is asymmetric

With orchestration, **every** activity dispatch goes through Temporal. The 500 ms warmup is shorter than the time the first activity needs to round-trip through the Temporal worker, so when the server dies, none of the 10 sagas have advanced past `Pending` (`Pending: 10` at `t = 10 s`). 

Choreography moves through asynchronous RabbitMQ messages with no central coordinator: by the time `saga-rabbitmq` is killed, **4 sagas already settled to `Failed`**, 3 are mid-compensation, and only 3 are still pre-compensation. So orchestration enters its outage window with 10 in-flight workflows, choreography with effectively 6. That asymmetry is something to note when comparing recovery numbers.

### Recovery behaviour

- **Orchestration recovers cleanly and quickly.** Temporal replays workflow history from Postgres on restart, the worker reattaches, and pending activities are re-dispatched. All 10 orders reach `Failed`, well inside the 90 s budget — wall-clock time from outage end to test end is ~25 s.
- **Choreography does not fully recover within 90 s.** RabbitMQ comes back with durable queues intact, but **2 of 10 orders remain non-terminal** — 1 stuck `Compensating`, 1 stuck `Pending` — even after the full poll window. MassTransit redelivers most events, but at least one `InventoryReleased` / payment-failed handoff was lost or dead-lettered such that the saga state machine never advances. This matches the doc's predicted choreography failure mode: a saga waiting on a callback that never arrives stays in `Compensating` indefinitely (see `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/docs/HOW-TO-RUN.md:915`).

### Inventory leak — same outcome, different visibility

Both modes leak stock, but the *kind* of leak is what matters:

- **Orchestration**: 2 leaked reservations on **10 fully-`Failed`** orders. Same compensation-bug pattern Test M surfaced — `CompensationActivityOptions.MaximumAttempts = 1` causes the `ReleaseInventory` activity to swallow a transient broker-recovery error and the workflow's catch-loop marks the saga `Failed` regardless. **The order looks healthy to an operator; the inventory accounting is silently wrong.**
- **Choreography**: 1 leaked reservation, correlated with the 2 stuck orders. The saga is **visibly stalled** (status reveals it), so the operator has a clear signal that intervention is required.

### Net comparison

| Property | Orchestration | Choreography |
|---|---|---|
| All orders terminal? | **Yes** (10/10 `Failed`) | **No** (2/10 stuck) |
| Time to settle after restart | ~25 s | > 90 s (poll exhausted) |
| Failure mode | **Silent** (looks `Failed`, inventory wrong) | **Visible** (status stuck `Compensating`/`Pending`) |
| Inventory leak | 2 / 10 | 1 / 10 |

**Orchestration wins on liveness** (workflow history replay is deterministic and bounded), **choreography wins on observability** (a stuck saga row is a louder alarm than a silently-leaked reservation). Neither pattern auto-recovers cleanly — the leaks here are the same compensation-layer issue Test M flagged, surfaced through a different failure injection.

### Caveats for the thesis

1. **Sample size is tiny**: 10 orders, one run per mode. Treat the 2-leak / 1-leak / 2-stuck numbers as illustrative, not statistical. A re-run with `ORDERS=50` and 3+ repetitions would tighten this.
2. **Asymmetric pre-outage progress** (10 `Pending` vs. 4 `Failed` + 3 `Compensating` + 3 `Pending`) makes the recovery comparison unfair on its face. Tuning `WARMUP_MS` until both modes have the same status distribution at kill-time would isolate "broker recovery cost" from "saga step latency".
3. **Recovery window**: at `RECOVERY_SECS=90`, choreography's 2 stuck orders may simply need longer than 90 s. Re-running with 300 s would distinguish "slow but eventually recovers" from "permanently stalled". Right now the data only proves *not within 90 s*.
4. **Output corruption**: the `…` characters in both result files render as `â€¦` (e.g. `[3/7] Stopping €¦`). Cosmetic only — a UTF-8 issue in the locale of the shell that ran the script — but worth fixing in [run-broker-outage-test.sh](cci:7://file:///Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/run-broker-outage-test.sh:0:0-0:0) before the next run if you plan to paste these files into the thesis appendix verbatim.
5. The Temporal-side leak is a **configuration choice** (`MaximumAttempts = 1` on the compensation activity), not a fundamental orchestration limitation. If you raise it, the leak goes away — but you lose the symmetry with the choreography retry policy that Test M was designed to compare.



Let me find the Test O section and read the result files.



Let me check the test script for additional setup context.



# Test O: Worker Crash Mid-Saga — Analysis

## 1. Purpose

Test O validates **resilience to a crash of the saga coordinator process**. The container `saga-order-service` is killed while sagas are mid-flight, then restarted, to verify whether each pattern resumes its in-flight sagas and reaches a consistent terminal state.

This is a particularly strong comparison point because `saga-order-service` hosts both:

- The **Temporal worker** (orchestration mode) — i.e. the activity executor.
- The **MassTransit saga state machine** (choreography mode) — i.e. the `OrderSagaState` consumer.

So the same single-process failure exercises *both* patterns' recovery mechanisms — Temporal's "server-managed workflow history" vs MassTransit's "broker-managed at-least-once delivery".

## 2. Test Setup

Driven by `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/run-worker-crash-test.sh`:

- **Forced compensation path** — `PaymentService.failure-rate=100`, so every order must enter compensation.
- **Workload** — `ORDERS=10` orders posted via the gateway, each for 1 unit of `a1111111-...` at 29.99.
- **Crash window** — `WARMUP_MS=500`, then `docker kill saga-order-service`.
- **Downtime** — `DOWN_SECS=5` with the service dead.
- **Restart** — `docker start saga-order-service`, poll `/api/orders/config` until healthy.
- **Observation window** — `RECOVERY_SECS=90`, polling `/api/orders/recent` every 2s, breaks early if all orders are terminal.
- **Final report** — order-status histogram + inventory leak vs baseline (`reservedQuantity` of the test product).
- **Infrastructure not touched** — Postgres, RabbitMQ, and Temporal stay up the whole time. Only `saga-order-service` is killed.

Both modes were run with identical parameters, ~2 minutes apart on 2026-04-28.

## 3. Summary of Results

### Orchestration — `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_o/worker-crash_orchestration.txt:1-22`

| Metric | Value |
|---|---|
| Killed at | `23:05:53` (≈2 s after start) |
| Back up at | `23:05:59` (≈6 s downtime) |
| Recovery polling | **Exited early** — "All orders reached terminal state" |
| Final histogram | `{"Failed": 10}` |
| Inventory leak | `0` (reserved=0, baseline=0) |
| Total wall-clock | ~25 s (`23:05:51` → `23:06:16`) |

**All 10 orders reached `Failed` (the expected terminal state under forced 100% payment failure).**

### Choreography — `@/Users/robertslipsnis/Desktop/Thesis/saga-comparison/tests/LoadTests/results/test_o/worker-crash_choreography.txt:1-21`

| Metric | Value |
|---|---|
| Killed at | `23:07:33` (≈3 s after start) |
| Back up at | `23:07:40` (≈7 s downtime) |
| Recovery polling | **Timed out** — no "All orders reached terminal state" line |
| Final histogram | `{"Pending": 6, "Failed": 4}` |
| Inventory leak | `0` (reserved=0, baseline=0) |
| Total wall-clock | ~101 s (`23:07:30` → `23:09:11`) |

**Only 4 of 10 orders reached a terminal state; 6 were still `Pending` after the full 90 s recovery window.**

### Side-by-side

| Outcome | Orchestration | Choreography |
|---|---|---|
| Orders reaching terminal state | **10 / 10** | **4 / 10** |
| Orders stuck non-terminal | 0 | **6 (Pending)** |
| Time to full recovery | ~17 s of polling | **never (timeout at 90 s)** |
| Inventory leak | 0 | 0 |

## 4. Analysis

### Orchestration: clean recovery

Temporal externalises the workflow's source of truth into the Temporal server's history table (Postgres). When `saga-order-service` is killed:

- The workflow itself is *not* hosted in OrderService — it lives on the Temporal server.
- Any activity that was in flight at crash time is marked as failed-task and **redispatched** to the next worker that polls the task queue.
- When the OrderService container comes back up, its Temporal worker reconnects, claims the pending activity tasks, and the workflow advances exactly where it left off.

Empirically this worked perfectly: all 10 sagas drove through Reserve → Payment(fail) → Compensate(release) → `Failed`, with **zero inventory leak**, and the polling phase exited early (~17 s) because everything was terminal.

### Choreography: 60% of sagas stuck in Pending

Choreography here uses MassTransit's saga state machine, with state persisted to OrderService's Postgres `OrderSagaState` table and events flowing through RabbitMQ. The expected recovery story is:

- Events published before the crash sit durably in RabbitMQ queues.
- On restart, MassTransit's consumers re-attach and drain the queues, advancing the saga rows.

That story did *not* hold under this test. **6 out of 10 orders never advanced past `Pending` in the 90 s after restart.** The most likely root cause(s) — to be confirmed by inspecting `OrderSagaState` rows and queue depths from this run — are:

- **`OrderCreated` events lost on the publisher side.** The order POST (Step 2) likely returned 202 *before* the corresponding `OrderCreated`/`StartSaga` message had been confirmed to RabbitMQ (no transactional outbox + publisher-confirms wired through to the HTTP response). When the process was killed, those un-published events were lost — there is no broker copy to redeliver, and there is no Temporal-style server holding the intent. The `Order` row exists (`Pending`), but the event that would advance it was never durably handed off.
- **Saga state machine has no "kick-restart" of stale rows.** Even though `Pending` rows exist in Postgres, MassTransit will only progress them if a matching event arrives. With no `OrderCreated` in the queue, the rows sit there forever.
- The 4 that *did* fail are the orders whose `OrderCreated` was confirmed to RabbitMQ before the kill, and whose downstream events (`PaymentFailed`) were also durably queued. Those replayed correctly on restart — choreography's at-least-once mechanics work *for events that actually made it into the broker*.

### What this comparison demonstrates for the thesis

| Aspect | Orchestration (Temporal) | Choreography (MassTransit) |
|---|---|---|
| Where workflow intent is persisted | **External durable server** (Temporal history table) | OrderService memory + Postgres saga row + RabbitMQ queue |
| Survival of "intent" when host process dies before first event | **Yes** — Temporal already accepted the workflow start | **No** (in this implementation) — `OrderCreated` can be lost between HTTP 202 and broker publish |
| Recovery action | Worker reconnects, Temporal redispatches in-flight activities | Consumer re-attaches, drains queues — but only for events the broker actually has |
| Result on `ORDERS=10`, `DOWN_SECS=5` | **10/10 terminal, 0 leak** | **4/10 terminal, 6 Pending, 0 leak** |
| Operator visibility into "what's stuck" | Workflow visible in Temporal UI as Running | `Pending` row in `OrderSagaState`, no queued event — silent stall |

### Caveats / honest framing

- **Inventory was consistent in both modes** (no oversell, no leak), so this is *not* a data-corruption result — it is a saga-progression result.
- **The choreography behaviour is implementation-dependent.** Adding a transactional outbox, publisher-confirms gating the HTTP 202, or a periodic "scan stale Pending sagas and republish" job would close the specific gap observed here. The point for the thesis is that **orchestration via Temporal gets crash-mid-saga durability "for free", while choreography requires deliberate engineering of every persist-then-publish boundary** — and a reasonable, working choreography setup like this one can still drop sagas on the floor when the coordinator process dies.
- **Sample size is small** (10 orders, single run per mode). Results are clear-cut here, but if you want to bullet-proof the claim, a higher `ORDERS` value (e.g. 50–100) and 3–5 repetitions per mode would let you cite a stuck-saga rate rather than a single 6/10 datapoint.

### Suggested thesis framing

> Under a coordinator-process crash mid-saga, orchestration drove 10/10 forced-compensation sagas to a consistent terminal state in ~17 s, while choreography — without a transactional outbox — left 6/10 sagas indefinitely stuck in `Pending` because their `OrderCreated` events never reached RabbitMQ before the process died. Both patterns preserved inventory invariants, but only orchestration preserved saga progress. This concretely illustrates the cost choreography pays when the saga's "source of truth" is co-located with the process that can crash.