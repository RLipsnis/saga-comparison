import http from 'k6/http';
import { check } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { Trend, Counter } from 'k6/metrics';

// =============================================================================
//  Saga Benchmark — full end-to-end + per-step timings
// =============================================================================
//
// Drives /api/orders/benchmark which creates an order, polls until the saga
// reaches a terminal state, and returns a single JSON payload with:
//
//   * apiResponseMs          — time from POST to saga-initiated
//   * totalSagaDurationMs    — time from saga-initiated to Order.Status terminal
//   * compensationDurationMs — Compensating → Failed window (null on success)
//   * stepDurationsMs        — per-step timings (reserveInventory, processPayment,
//                               arrangeShipping, sendNotification, updateStatus)
//
// This script aggregates ALL of the above into k6 Trends so one test run
// produces both the headline saga metrics AND the per-step bottleneck
// breakdown. Previously split across benchmark-saga-steps.js and
// benchmark-step-durations.js, which hit the same endpoint with redundant load.

const apiResponseTime      = new Trend('api_response_ms',           true);
const totalSagaDuration    = new Trend('total_saga_duration_ms',    true);
const compensationDuration = new Trend('compensation_duration_ms',  true);

// Per-step breakdowns from OrderResult.StepDurationsMs (orchestration) or the
// saga state timestamps (choreography). See OrdersController.Benchmark.
const stepInventory     = new Trend('step_reserve_inventory_ms', true);
const stepPayment       = new Trend('step_process_payment_ms',   true);
const stepShipping      = new Trend('step_arrange_shipping_ms',  true);
const stepNotification  = new Trend('step_send_notification_ms', true);
const stepUpdateStatus  = new Trend('step_update_status_ms',     true);

const ordersCompleted   = new Counter('orders_completed');
const ordersFailed      = new Counter('orders_failed');
const ordersCompensated = new Counter('orders_compensated');

const RATE     = __ENV.RATE ? parseInt(__ENV.RATE) : 1;
const DURATION = __ENV.DURATION || '60s';
const WARMUP   = __ENV.WARMUP   || '5s';   // low-rate warmup to prime pools / JIT
const BASE_URL = __ENV.BASE_URL || 'http://localhost:5005';
const MODE     = __ENV.MODE     || 'unknown';
const RESULT_STAMP = new Date().toISOString().replace(/[:.]/g, '-');

const PRODUCTS = [
  { productId: 'a1111111-1111-1111-1111-111111111111', unitPrice: 29.99 },
  { productId: 'a2222222-2222-2222-2222-222222222222', unitPrice: 89.99 },
  { productId: 'a3333333-3333-3333-3333-333333333333', unitPrice: 49.99 },
];

export const options = {
  scenarios: {
    warmup: {
      executor: 'constant-arrival-rate',
      rate: Math.max(1, Math.floor(RATE / 4)),
      timeUnit: '1s',
      duration: WARMUP,
      preAllocatedVUs: Math.max(4, RATE),
      maxVUs: Math.max(10, RATE * 2),
      exec: 'placeOrder',
      tags: { phase: 'warmup' },
    },
    benchmark: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      startTime: WARMUP,                       // run after warmup
      preAllocatedVUs: Math.max(RATE * 2, 10), // tighter than before; raise if VUs saturate
      maxVUs: Math.max(RATE * 5, 50),
      exec: 'placeOrder',
      tags: { phase: 'main' },
    },
  },
  thresholds: {
    // Only evaluate thresholds on the main phase, not warmup.
    'total_saga_duration_ms{phase:main}': ['p(95)<10000'],
    'api_response_ms{phase:main}':         ['p(95)<2000'],
  },
};

export function placeOrder() {
  const product = PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)];

  const payload = JSON.stringify({
    customerId: uuidv4(),
    items: [{ productId: product.productId, quantity: 1, unitPrice: product.unitPrice }],
  });

  const res = http.post(`${BASE_URL}/api/orders/benchmark`, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '35s',
  });

  const ok = check(res, { 'status is 200': (r) => r.status === 200 });
  if (!ok) {
    ordersFailed.add(1);
    return;
  }

  const data = JSON.parse(res.body);
  apiResponseTime.add(data.apiResponseMs);
  totalSagaDuration.add(data.totalSagaDurationMs);

  if (data.compensated && data.compensationDurationMs !== null) {
    compensationDuration.add(data.compensationDurationMs);
    ordersCompensated.add(1);
  }

  if (data.finalStatus === 'Completed') {
    ordersCompleted.add(1);
  } else {
    ordersFailed.add(1);
  }

  // Per-step breakdowns (when returned by the /benchmark endpoint).
  if (data.stepDurationsMs) {
    const s = data.stepDurationsMs;
    if (s.reserveInventory !== undefined) stepInventory.add(s.reserveInventory);
    if (s.processPayment   !== undefined) stepPayment.add(s.processPayment);
    if (s.arrangeShipping  !== undefined) stepShipping.add(s.arrangeShipping);
    if (s.sendNotification !== undefined) stepNotification.add(s.sendNotification);
    if (s.updateStatus     !== undefined) stepUpdateStatus.add(s.updateStatus);
  }
}

// Default export required for k6 when no scenario specifies `exec`. Our scenarios
// both reference placeOrder, but k6 still inspects the default export at startup.
export default function () { placeOrder(); }

export function handleSummary(data) {
  function pctls(metric) {
    if (!metric || !metric.values || !metric.values.count) return null;
    const v = metric.values;
    return {
      min: (v.min      || 0).toFixed(1),
      avg: (v.avg      || 0).toFixed(1),
      med: (v.med      || 0).toFixed(1),
      p90: (v['p(90)'] || 0).toFixed(1),
      p95: (v['p(95)'] || 0).toFixed(1),
      p99: (v['p(99)'] || 0).toFixed(1),
      max: (v.max      || 0).toFixed(1),
      count: v.count || 0,
    };
  }

  function fmtStep(name, metric) {
    const p = pctls(metric);
    if (!p) return `    ${name}: (no data)`;
    return `    ${name}: avg=${p.avg}  med=${p.med}  p95=${p.p95}  p99=${p.p99}  max=${p.max}`;
  }

  const apiP        = pctls(data.metrics.api_response_ms)        || {};
  const sagaP       = pctls(data.metrics.total_saga_duration_ms) || {};
  const compP       = pctls(data.metrics.compensation_duration_ms);
  const completed   = data.metrics.orders_completed   ? data.metrics.orders_completed.values.count   : 0;
  const failed      = data.metrics.orders_failed      ? data.metrics.orders_failed.values.count      : 0;
  const compensated = data.metrics.orders_compensated ? data.metrics.orders_compensated.values.count : 0;

  const summary = [
    '',
    '═══════════════════════════════════════════════════════════════',
    `  SAGA BENCHMARK — ${MODE.toUpperCase()}`,
    `  Rate: ${RATE} req/s | Warmup: ${WARMUP} | Main: ${DURATION}`,
    '═══════════════════════════════════════════════════════════════',
    '',
    `  Orders: ${completed} completed, ${failed} failed, ${compensated} compensated`,
    '',
    '  API Response (ms):',
    `    min=${apiP.min}  avg=${apiP.avg}  med=${apiP.med}  p95=${apiP.p95}  p99=${apiP.p99}  max=${apiP.max}`,
    '',
    '  Total Saga Duration (ms):',
    `    min=${sagaP.min}  avg=${sagaP.avg}  med=${sagaP.med}  p95=${sagaP.p95}  p99=${sagaP.p99}  max=${sagaP.max}`,
    '',
    '  Compensation Duration (ms):',
    compP
      ? `    min=${compP.min}  avg=${compP.avg}  med=${compP.med}  p95=${compP.p95}  p99=${compP.p99}  max=${compP.max}`
      : '    (no compensations observed)',
    '',
    '  Per-step breakdown (ms):',
    fmtStep('Reserve Inventory ', data.metrics.step_reserve_inventory_ms),
    fmtStep('Process Payment   ', data.metrics.step_process_payment_ms),
    fmtStep('Arrange Shipping  ', data.metrics.step_arrange_shipping_ms),
    fmtStep('Send Notification ', data.metrics.step_send_notification_ms),
    fmtStep('Update Status     ', data.metrics.step_update_status_ms),
    '',
    '═══════════════════════════════════════════════════════════════',
    '',
  ].join('\n');

  const jsonResult = {
    mode: MODE,
    rate: parseInt(RATE),
    duration: DURATION,
    warmup: WARMUP,
    totals: { completed, failed, compensated },
    apiResponseMs:          pctls(data.metrics.api_response_ms),
    totalSagaDurationMs:    pctls(data.metrics.total_saga_duration_ms),
    compensationDurationMs: compP,
    stepDurationsMs: {
      reserveInventory:  pctls(data.metrics.step_reserve_inventory_ms),
      processPayment:    pctls(data.metrics.step_process_payment_ms),
      arrangeShipping:   pctls(data.metrics.step_arrange_shipping_ms),
      sendNotification:  pctls(data.metrics.step_send_notification_ms),
      updateStatus:      pctls(data.metrics.step_update_status_ms),
    },
  };

  return {
    stdout: summary,
    // Timestamped copy so repeat runs at the same rate don't overwrite history.
    [`results/steps_${MODE}_${RATE}rps_${RESULT_STAMP}.json`]: JSON.stringify(jsonResult, null, 2),
    // Stable canonical filename that run-full-benchmark.sh appends to its summary.
    [`results/steps_${MODE}_${RATE}rps.json`]: JSON.stringify(jsonResult, null, 2),
  };
}
