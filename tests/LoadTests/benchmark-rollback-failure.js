import http from 'k6/http';
import { check, sleep } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { Trend, Counter } from 'k6/metrics';

// =============================================================================
//  Test M — Failure DURING Rollback (the "lecturer's scenario")
// =============================================================================
//
// Reproduces the scenario the supervisor described:
//
//   "scenārijs:
//      sākas rollback
//      rollback laikā:
//        Notification service down
//        vai Inventory service fail
//      Vai sistēma atkopjas vai paliek inconsistent?"
//
// Test I (compensation-correctness) only verifies the HAPPY compensation path:
// payment fails → release succeeds → state restored. This test verifies what
// happens when a compensation step ITSELF fails.
//
// Sequence:
//   1. Force PaymentService to fail 100% of the time → triggers compensation.
//   2. Force the chosen target service (InventoryService.Release OR
//      NotificationService.Send) to fail 100% of the time.
//   3. Place N orders. Each order: Reserve OK → Payment FAIL → enters
//      compensation → compensation-target FAILS.
//   4. Poll each order until terminal state OR timeout.
//   5. Snapshot inventory and order statuses.
//   6. Reset all failure rates and re-snapshot to see if anything self-heals.
//
// Expected divergence between patterns (the thesis finding):
//
//   FAIL_TARGET=inventory:
//     • Orchestration (Temporal): CompensationActivityOptions = MaximumAttempts:1.
//       Release fails once, exception is swallowed in the workflow's catch loop,
//       order is marked Failed. Inventory reservation LEAKS — state inconsistent.
//     • Choreography (MassTransit): UseMessageRetry retries Release 3x, then
//       sends to release-inventory_error DLQ. Saga waits forever for
//       InventoryReleased event that never comes. Order STUCK in Compensating.
//       Both inventory AND saga state are inconsistent.
//
//   FAIL_TARGET=notification:
//     • Both patterns: failure-notification is best-effort (catch + log). Order
//       reaches Failed cleanly, inventory is properly released. Only the
//       customer-facing message is lost. State stays consistent but UX degrades.
//
// Usage:
//   k6 run --env MODE=orchestration --env FAIL_TARGET=inventory  benchmark-rollback-failure.js
//   k6 run --env MODE=orchestration --env FAIL_TARGET=notification benchmark-rollback-failure.js
//   (typically run via: ./run-test.sh rollback-failure --env FAIL_TARGET=inventory)

const timeToTerminal     = new Trend('time_to_terminal_ms', true);
const ordersFailed       = new Counter('orders_reached_failed');
const ordersStuck        = new Counter('orders_stuck_compensating');
const ordersInconsistent = new Counter('orders_inconsistent');

const BASE_URL    = __ENV.BASE_URL    || 'http://localhost:5005';
const MODE        = __ENV.MODE        || 'unknown';
const FAIL_TARGET = __ENV.FAIL_TARGET || 'inventory';   // 'inventory' | 'notification'
const ITERATIONS  = __ENV.ITERATIONS ? parseInt(__ENV.ITERATIONS) : 10;
const PRODUCT_ID  = 'a1111111-1111-1111-1111-111111111111';
const TIMEOUT_MS  = parseInt(__ENV.TIMEOUT_MS || '15000');
const RESULT_STAMP = new Date().toISOString().replace(/[:.]/g, '-');

if (FAIL_TARGET !== 'inventory' && FAIL_TARGET !== 'notification') {
  throw new Error(`FAIL_TARGET must be 'inventory' or 'notification', got '${FAIL_TARGET}'`);
}

export const options = {
  scenarios: {
    rollbackFailure: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: ITERATIONS,
      maxDuration: '15m',
    },
  },
  // No hard threshold — this test is supposed to produce inconsistency on
  // purpose. We assert by reporting the counts in handleSummary.
};

function setFailureRate(serviceUrl, rate) {
  const res = http.post(`${serviceUrl}/${rate}`);
  if (res.status !== 200) {
    throw new Error(`Failed to set ${serviceUrl}: HTTP ${res.status} ${res.body}`);
  }
}

export function setup() {
  // Reset all state
  http.post(`${BASE_URL}/api/inventory/reset`);
  http.del(`${BASE_URL}/api/orders/reset`);

  // Snapshot baseline
  const invRes = http.get(`${BASE_URL}/api/inventory/products`);
  const products = JSON.parse(invRes.body);
  const product = products.find(p => p.id === PRODUCT_ID);
  const baselineReserved = product ? product.reservedQuantity : 0;
  const baselineStock    = product ? product.stockQuantity    : 0;

  // Force payment to always fail → triggers compensation
  setFailureRate(`${BASE_URL}/api/payments/failure-rate`, 100);

  // Force the chosen compensation step to always fail
  if (FAIL_TARGET === 'inventory') {
    setFailureRate(`${BASE_URL}/api/inventory/release-failure-rate`, 100);
  } else {
    setFailureRate(`${BASE_URL}/api/notifications/failure-rate`, 100);
  }

  console.log(`[setup] Mode=${MODE}  FailTarget=${FAIL_TARGET}  Iterations=${ITERATIONS}`);
  console.log(`[setup] Baseline reserved=${baselineReserved}, stock=${baselineStock}`);

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
    console.warn(`Order not accepted: ${postRes.status} ${postRes.body}`);
    return;
  }

  const orderId = JSON.parse(postRes.body).orderId;

  // Poll until terminal OR timeout
  const deadline = start + TIMEOUT_MS;
  let finalStatus = null;
  let elapsedMs   = -1;

  while (Date.now() < deadline) {
    sleep(0.1);
    const statusRes = http.get(`${BASE_URL}/api/orders/${orderId}/status`);
    if (statusRes.status !== 200) continue;
    const status = JSON.parse(statusRes.body).status;
    if (status === 'Failed' || status === 'Completed') {
      finalStatus = status;
      elapsedMs = Date.now() - start;
      break;
    }
  }

  if (finalStatus === 'Failed') {
    ordersFailed.add(1);
    timeToTerminal.add(elapsedMs);
  } else if (finalStatus === 'Completed') {
    // Should not happen with payment failure rate at 100
    console.warn(`Order ${orderId} unexpectedly Completed under 100% payment failure`);
  } else {
    // Never reached terminal state — stuck in Compensating
    ordersStuck.add(1);
    const last = http.get(`${BASE_URL}/api/orders/${orderId}/status`);
    const lastStatus = last.status === 200 ? JSON.parse(last.body).status : 'unreachable';
    console.warn(`Order ${orderId} stuck after ${TIMEOUT_MS}ms — last status=${lastStatus}`);
  }

  sleep(0.3);
}

export function teardown(setupData) {
  // Reset failure rates BEFORE measuring final state, so we don't break the
  // post-test inventory snapshot itself if the saga retries late.
  http.post(`${BASE_URL}/api/payments/failure-rate/0`);
  http.post(`${BASE_URL}/api/inventory/release-failure-rate/0`);
  http.post(`${BASE_URL}/api/notifications/failure-rate/0`);
  console.log('[teardown] All failure rates reset to 0');

  // Wait for any in-flight retries / DLQs to drain
  sleep(5);

  // === Inventory snapshot (PRIMARY consistency check) ===
  const invRes = http.get(`${BASE_URL}/api/inventory/products`);
  let currentReserved = -1;
  let inventoryConsistent = false;
  if (invRes.status === 200) {
    const products = JSON.parse(invRes.body);
    const product = products.find(p => p.id === PRODUCT_ID);
    if (product) {
      currentReserved = product.reservedQuantity;
      inventoryConsistent = (currentReserved === setupData.baselineReserved);
    }
  }

  // === Order status histogram ===
  const ordersRes = http.get(`${BASE_URL}/api/orders/recent?limit=200`);
  let statuses = {};
  let stuckCount = 0;
  let failedCount = 0;
  if (ordersRes.status === 200) {
    const orders = JSON.parse(ordersRes.body);
    statuses = orders.reduce((acc, o) => {
      acc[o.status] = (acc[o.status] || 0) + 1;
      return acc;
    }, {});
    stuckCount  = (statuses['Pending'] || 0) + (statuses['Compensating'] || 0);
    failedCount = statuses['Failed'] || 0;
  }

  // For inventory-failure runs: a "leaked" reservation means the order reached
  // Failed but the inventory was never released. That is the headline bad case.
  const inventoryLeak = Math.max(0, currentReserved - setupData.baselineReserved);

  // For notification-failure runs the inventory should be CLEAN — if it isn't,
  // something else is wrong.
  const inconsistent = (FAIL_TARGET === 'inventory')
    ? (!inventoryConsistent || stuckCount > 0)
    : (!inventoryConsistent);

  if (inconsistent) ordersInconsistent.add(stuckCount + inventoryLeak);

  console.log('');
  console.log('=== ROLLBACK-FAILURE TEARDOWN SNAPSHOT ===');
  console.log(`  Mode:                  ${MODE}`);
  console.log(`  Fail target:           ${FAIL_TARGET}`);
  console.log(`  Inventory reserved:    ${currentReserved} (baseline=${setupData.baselineReserved})  ${inventoryConsistent ? 'CONSISTENT' : 'LEAKED ' + inventoryLeak}`);
  console.log(`  Orders by status:      ${JSON.stringify(statuses)}`);
  console.log(`  Orders stuck:          ${stuckCount}`);
  console.log(`  Orders Failed:         ${failedCount}`);
  console.log('');
}

export function handleSummary(data) {
  function pctls(metric) {
    if (!metric || !metric.values) return null;
    const v = metric.values;
    return {
      count: v.count,
      avg: (v.avg      || 0).toFixed(1),
      med: (v.med      || 0).toFixed(1),
      p95: (v['p(95)'] || 0).toFixed(1),
      max: (v.max      || 0).toFixed(1),
    };
  }

  const t      = pctls(data.metrics.time_to_terminal_ms);
  const failed = data.metrics.orders_reached_failed     ? data.metrics.orders_reached_failed.values.count     : 0;
  const stuck  = data.metrics.orders_stuck_compensating ? data.metrics.orders_stuck_compensating.values.count : 0;
  const incons = data.metrics.orders_inconsistent       ? data.metrics.orders_inconsistent.values.count       : 0;

  const summary = [
    '',
    '═══════════════════════════════════════════════════════════════',
    `  ROLLBACK-FAILURE — ${MODE.toUpperCase()}  (target=${FAIL_TARGET})`,
    `  Iterations: ${ITERATIONS}`,
    '═══════════════════════════════════════════════════════════════',
    '',
    `  Orders reached Failed:    ${failed} / ${ITERATIONS}`,
    `  Orders stuck (timeout):   ${stuck}`,
    `  Inconsistent units:       ${incons}   (leaked reservations + stuck orders)`,
    '',
    '  Time to terminal (ms):',
    t
      ? `    avg=${t.avg}  med=${t.med}  p95=${t.p95}  max=${t.max}`
      : '    (no orders reached terminal — all stuck)',
    '',
    '  (Check teardown logs above for inventory + order-status histogram)',
    '',
    '═══════════════════════════════════════════════════════════════',
    '',
  ].join('\n');

  const jsonResult = {
    mode: MODE,
    test: 'rollback_failure',
    failTarget: FAIL_TARGET,
    iterations: ITERATIONS,
    ordersReachedFailed: failed,
    ordersStuck: stuck,
    inconsistentUnits: incons,
    timeToTerminalMs: t,
  };

  return {
    stdout: summary,
    [`results/rollback-failure_${MODE}_${FAIL_TARGET}_${RESULT_STAMP}.json`]: JSON.stringify(jsonResult, null, 2),
    [`results/rollback-failure_${MODE}_${FAIL_TARGET}.json`]: JSON.stringify(jsonResult, null, 2),
  };
}
