import http from 'k6/http';
import { check, sleep } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { Trend, Counter } from 'k6/metrics';

// =============================================================================
//  Cold-Start Benchmark
// =============================================================================
//
// Measures the latency penalty of the first few orders after a fresh service
// start. Reports per-request duration for requests 1..N sequentially (one at a
// time) so you can see:
//   * Temporal worker cold-start cost (first workflow activation)
//   * MassTransit consumer subscription + channel setup on first message
//   * EF Core query plan compilation
//   * .NET JIT tiered compilation
//
// The assumed warm-up target is the average of requests N/2..N (the "warm" tail
// of the sequence). Cold penalty = request[1] − warm average.
//
// USAGE — CRITICAL: services MUST be freshly restarted before running.
//   1. Stop all .NET services (Ctrl+C in each terminal)
//   2. Start them again in the same order as HOW-TO-RUN.md
//   3. Wait ~5s for them to open their TCP listeners
//   4. k6 run --env MODE=orchestration --env ITERATIONS=20 benchmark-cold-start.js
//
// The script does NOT restart services for you — it can only measure what's
// running. If you forget to restart, you'll see flat "warm" timings.

const requestDuration = new Trend('cold_request_duration_ms', true);
const requestsOk      = new Counter('requests_ok');
const requestsFailed  = new Counter('requests_failed');

const BASE_URL   = __ENV.BASE_URL   || 'http://localhost:5005';
const MODE       = __ENV.MODE       || 'unknown';
const ITERATIONS = __ENV.ITERATIONS ? parseInt(__ENV.ITERATIONS) : 20;
const GAP_MS     = __ENV.GAP_MS     ? parseInt(__ENV.GAP_MS)     : 500;
const RESULT_STAMP = new Date().toISOString().replace(/[:.]/g, '-');

// Collect per-index durations in a shared array so we can print the full curve.
const perIndexDurations = [];

export const options = {
  scenarios: {
    coldstart: {
      executor: 'per-vu-iterations',
      vus: 1,                                // sequential, one at a time
      iterations: ITERATIONS,
      maxDuration: '5m',
    },
  },
};

export function setup() {
  http.post(`${BASE_URL}/api/inventory/reset`);
  http.del(`${BASE_URL}/api/orders/reset`);
  http.post(`${BASE_URL}/api/payments/failure-rate/0`);
  sleep(2);
  console.log('[setup] State reset complete (ensure services were freshly restarted!)');
}

export default function () {
  // __ITER is 0-indexed; shift to 1-indexed for human-friendly output.
  const index = (__ITER || 0) + 1;

  const payload = JSON.stringify({
    customerId: uuidv4(),
    items: [{ productId: 'a1111111-1111-1111-1111-111111111111', quantity: 1, unitPrice: 29.99 }],
  });

  const start = Date.now();
  const res   = http.post(`${BASE_URL}/api/orders/benchmark`, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '35s',
  });
  const duration = Date.now() - start;

  const ok = check(res, { 'status is 200': (r) => r.status === 200 });
  requestDuration.add(duration, { index: String(index) });
  perIndexDurations.push({ index, durationMs: duration, ok });

  if (ok) {
    requestsOk.add(1);
  } else {
    requestsFailed.add(1);
  }

  console.log(`[cold-start] #${index} — ${duration} ms ${ok ? 'OK' : 'FAIL'}`);

  if (index < ITERATIONS) sleep(GAP_MS / 1000);
}

export function handleSummary(data) {
  // Sort by index in case iterations completed out-of-order (shouldn't with vus=1).
  perIndexDurations.sort((a, b) => a.index - b.index);

  const firstReq = perIndexDurations[0];
  const tailHalf = perIndexDurations.slice(Math.ceil(perIndexDurations.length / 2));
  const warmAvg  = tailHalf.length
    ? tailHalf.reduce((s, r) => s + r.durationMs, 0) / tailHalf.length
    : 0;
  const coldPenalty = firstReq ? (firstReq.durationMs - warmAvg) : 0;

  const table = perIndexDurations.map(r =>
    `    #${String(r.index).padStart(2, ' ')}  ${String(r.durationMs).padStart(6, ' ')} ms  ${r.ok ? '' : 'FAIL'}`
  ).join('\n');

  const summary = [
    '',
    '═══════════════════════════════════════════════════════════════',
    `  COLD-START — ${MODE.toUpperCase()}`,
    `  Iterations: ${ITERATIONS}  |  Gap between requests: ${GAP_MS}ms`,
    '═══════════════════════════════════════════════════════════════',
    '',
    '  Per-request duration:',
    table,
    '',
    `  First request       : ${firstReq ? firstReq.durationMs.toFixed(0) : 'n/a'} ms`,
    `  Warm tail average   : ${warmAvg.toFixed(0)} ms (last ${tailHalf.length} requests)`,
    `  Cold-start penalty  : ${coldPenalty.toFixed(0)} ms`,
    '',
    '═══════════════════════════════════════════════════════════════',
    '',
  ].join('\n');

  const jsonResult = {
    mode: MODE,
    test: 'cold_start',
    iterations: ITERATIONS,
    gapMs: GAP_MS,
    perRequestMs: perIndexDurations,
    firstRequestMs: firstReq ? firstReq.durationMs : null,
    warmTailAvgMs:  Math.round(warmAvg),
    coldPenaltyMs:  Math.round(coldPenalty),
  };

  return {
    stdout: summary,
    [`results/coldstart_${MODE}_${RESULT_STAMP}.json`]: JSON.stringify(jsonResult, null, 2),
    [`results/coldstart_${MODE}.json`]: JSON.stringify(jsonResult, null, 2),
  };
}
