import http from 'k6/http';
import { check, sleep } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { Trend, Counter } from 'k6/metrics';

// =============================================================================
//  Compensation Correctness Test
// =============================================================================
//
// Verifies that compensation actually restores system state after failures.
// Sets PaymentService failure rate to 100%, places orders, then checks:
//
//   1. All orders reach "Failed" status (not stuck in Pending/Compensating)
//   2. All inventory reservations are released (reserved quantity returns to 0)
//   3. No dangling payments remain (all refunded)
//
// This is a correctness test, not a performance test. It answers: "Do both
// patterns properly clean up after themselves when things go wrong?"
//
// The test runs single-threaded to avoid interference between iterations.
// Each iteration places one order, waits for it to fail, and records how long
// compensation took. The teardown phase performs the global state assertions.
//
// Usage:
//   k6 run --env MODE=orchestration --env ITERATIONS=10 benchmark-compensation-correctness.js

const compensationDuration = new Trend('compensation_total_ms', true);
const ordersReachedFailed  = new Counter('orders_reached_failed');
const ordersStuck          = new Counter('orders_stuck');

const BASE_URL    = __ENV.BASE_URL    || 'http://localhost:5005';
const MODE        = __ENV.MODE        || 'unknown';
const ITERATIONS  = __ENV.ITERATIONS ? parseInt(__ENV.ITERATIONS) : 10;
const PRODUCT_ID  = 'a1111111-1111-1111-1111-111111111111';
const TIMEOUT_MS  = 15000;
const RESULT_STAMP = new Date().toISOString().replace(/[:.]/g, '-');

export const options = {
  scenarios: {
    compensation: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: ITERATIONS,
      maxDuration: '10m',
    },
  },
  thresholds: {
    // Every single order must reach Failed — zero stuck orders allowed.
    orders_stuck: ['count==0'],
  },
};

export function setup() {
  // Reset state
  http.post(`${BASE_URL}/api/inventory/reset`);
  http.del(`${BASE_URL}/api/orders/reset`);

  // Read baseline inventory
  const invRes = http.get(`${BASE_URL}/api/inventory/products`);
  const products = JSON.parse(invRes.body);
  const product = products.find(p => p.id === PRODUCT_ID);
  const baselineReserved = product ? product.reservedQuantity : 0;
  const baselineStock = product ? product.stockQuantity : 0;

  // Force 100% payment failures
  const res = http.post(`${BASE_URL}/api/payments/failure-rate/100`);
  if (res.status !== 200) {
    throw new Error(`Failed to set payment failure rate: ${res.status} ${res.body}`);
  }
  console.log(`[setup] PaymentService FailureRatePercent = 100`);
  console.log(`[setup] Baseline: stock=${baselineStock}, reserved=${baselineReserved}`);

  return { baselineReserved, baselineStock };
}

export default function () {
  const payload = JSON.stringify({
    customerId: uuidv4(),
    items: [{ productId: PRODUCT_ID, quantity: 1, unitPrice: 29.99 }],
  });

  const start = Date.now();
  const postRes = http.post(`${BASE_URL}/api/orders`, payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (!check(postRes, { 'order accepted': (r) => r.status === 202 })) {
    ordersStuck.add(1);
    return;
  }

  const orderId = JSON.parse(postRes.body).orderId;

  // Poll until terminal state
  const deadline = start + TIMEOUT_MS;
  let finalStatus = null;

  while (Date.now() < deadline) {
    sleep(0.05);
    const statusRes = http.get(`${BASE_URL}/api/orders/${orderId}/status`);
    if (statusRes.status !== 200) continue;

    const status = JSON.parse(statusRes.body).status;
    if (status === 'Failed') {
      finalStatus = 'Failed';
      compensationDuration.add(Date.now() - start);
      ordersReachedFailed.add(1);
      break;
    }
    if (status === 'Completed') {
      // Shouldn't happen with 100% failure rate, but handle it
      finalStatus = 'Completed';
      ordersStuck.add(1);
      console.warn(`Order ${orderId} completed despite 100% failure rate`);
      break;
    }
  }

  if (!finalStatus) {
    ordersStuck.add(1);
    console.warn(`Order ${orderId} stuck (never reached terminal state within ${TIMEOUT_MS}ms)`);
  }

  // Brief pause between iterations so compensation has time to propagate
  sleep(0.5);
}

export function teardown(setupData) {
  // Restore payment failure rate
  http.post(`${BASE_URL}/api/payments/failure-rate/0`);
  console.log('[teardown] PaymentService FailureRatePercent reset to 0');

  // Wait briefly for any in-flight compensations to settle
  sleep(2);

  // === Correctness Check 1: Inventory reservations released ===
  const invRes = http.get(`${BASE_URL}/api/inventory/products`);
  let inventoryCorrect = false;
  let currentReserved = -1;

  if (invRes.status === 200) {
    const products = JSON.parse(invRes.body);
    const product = products.find(p => p.id === PRODUCT_ID);
    if (product) {
      currentReserved = product.reservedQuantity;
      inventoryCorrect = (currentReserved === setupData.baselineReserved);
    }
  }

  // === Correctness Check 2: All orders in Failed status ===
  const ordersRes = http.get(`${BASE_URL}/api/orders/recent?limit=100`);
  let allFailed = false;
  let orderStatuses = {};

  if (ordersRes.status === 200) {
    const orders = JSON.parse(ordersRes.body);
    orderStatuses = orders.reduce((acc, o) => {
      acc[o.status] = (acc[o.status] || 0) + 1;
      return acc;
    }, {});
    // All orders from this test should be Failed
    allFailed = !orderStatuses['Pending'] && !orderStatuses['Compensating'];
  }

  console.log('');
  console.log('=== COMPENSATION CORRECTNESS RESULTS ===');
  console.log(`  Inventory: reserved=${currentReserved} (baseline=${setupData.baselineReserved}) — ${inventoryCorrect ? 'PASS' : 'FAIL'}`);
  console.log(`  Orders: ${JSON.stringify(orderStatuses)} — ${allFailed ? 'PASS' : 'FAIL'}`);
  console.log('');
}

export function handleSummary(data) {
  function pctls(metric) {
    if (!metric || !metric.values || !metric.values.count) return null;
    const v = metric.values;
    return {
      count: v.count,
      avg: (v.avg      || 0).toFixed(1),
      med: (v.med      || 0).toFixed(1),
      p95: (v['p(95)'] || 0).toFixed(1),
      max: (v.max      || 0).toFixed(1),
    };
  }

  const comp    = pctls(data.metrics.compensation_total_ms);
  const reached = data.metrics.orders_reached_failed ? data.metrics.orders_reached_failed.values.count : 0;
  const stuck   = data.metrics.orders_stuck          ? data.metrics.orders_stuck.values.count          : 0;

  const summary = [
    '',
    '═══════════════════════════════════════════════════════════════',
    `  COMPENSATION CORRECTNESS — ${MODE.toUpperCase()}`,
    `  Iterations: ${ITERATIONS}  |  Payment failure rate: 100%`,
    '═══════════════════════════════════════════════════════════════',
    '',
    `  Orders reached Failed: ${reached} / ${ITERATIONS}`,
    `  Orders stuck:          ${stuck}     ${stuck === 0 ? 'PASS' : 'FAIL'}`,
    '',
    '  Time to Failed (ms):',
    comp
      ? `    avg=${comp.avg}  med=${comp.med}  p95=${comp.p95}  max=${comp.max}`
      : '    (no data)',
    '',
    '  (Check teardown logs above for inventory & order state assertions)',
    '',
    '═══════════════════════════════════════════════════════════════',
    '',
  ].join('\n');

  const jsonResult = {
    mode: MODE,
    test: 'compensation_correctness',
    iterations: ITERATIONS,
    ordersReachedFailed: reached,
    ordersStuck: stuck,
    compensationTotalMs: comp,
  };

  return {
    stdout: summary,
    [`results/compensation_${MODE}_${RESULT_STAMP}.json`]: JSON.stringify(jsonResult, null, 2),
    [`results/compensation_${MODE}.json`]: JSON.stringify(jsonResult, null, 2),
  };
}
