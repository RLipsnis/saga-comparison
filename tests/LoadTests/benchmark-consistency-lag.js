import http from 'k6/http';
import { sleep } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { Trend, Counter } from 'k6/metrics';

// =============================================================================
//  Inventory Visibility Lag Test
// =============================================================================
//
// Measures how long after POST /api/orders the reserved stock becomes visible to
// an external observer via GET /api/inventory/products.
//
// This is the true "eventual consistency lag" a UI or downstream dashboard would
// experience: the gap between the user's order being accepted and the side-effect
// (stock decrement) being readable through the inventory API.
//
// Metrics captured (ms):
//   * inventory_visibility_lag_ms — time from POST to reserved stock decrement visible
//   * saga_completion_lag_ms       — time from POST to Order.Status = Completed
//   * inventory_release_lag_ms     — (if the order is forced to fail) time from POST
//                                     to the reservation being released again
//
// The orchestration vs choreography delta on inventory_visibility_lag_ms is the
// cleanest answer to "how fast does external state reflect an order?" — it avoids
// the earlier version's mistake of polling Order.Status for intermediate states
// that are never actually written to the DB.

const inventoryLag       = new Trend('inventory_visibility_lag_ms', true);
const sagaCompletionLag  = new Trend('saga_completion_lag_ms',      true);
const inventoryReleaseLag = new Trend('inventory_release_lag_ms',   true);
const ordersCompleted    = new Counter('orders_completed');
const ordersFailed       = new Counter('orders_failed');
const ordersTimedOut     = new Counter('orders_timed_out');

const BASE_URL    = __ENV.BASE_URL    || 'http://localhost:5005';
const MODE        = __ENV.MODE        || 'unknown';
const ITERATIONS  = __ENV.ITERATIONS ? parseInt(__ENV.ITERATIONS) : 20;
const PRODUCT_ID  = __ENV.PRODUCT_ID  || 'a1111111-1111-1111-1111-111111111111';

const POLL_INTERVAL_S = 0.025;   // poll inventory / status every 25ms
const TIMEOUT_MS      = 15000;   // give up after 15s per iteration
const RESULT_STAMP    = new Date().toISOString().replace(/[:.]/g, '-');

export const options = {
  scenarios: {
    consistency: {
      executor: 'per-vu-iterations',
      vus: 1,           // single VU — otherwise inventory counters interfere
      iterations: ITERATIONS,
      maxDuration: '10m',
    },
  },
};

export function setup() {
  http.post(`${BASE_URL}/api/inventory/reset`);
  http.del(`${BASE_URL}/api/orders/reset`);
  http.post(`${BASE_URL}/api/payments/failure-rate/0`);
  sleep(2);
  console.log('[setup] State reset complete');
}

function getReserved(productId) {
  const res = http.get(`${BASE_URL}/api/inventory/products`);
  if (res.status !== 200) return null;
  const list = JSON.parse(res.body);
  const p = list.find(x => x.id === productId);
  return p ? p.reservedQuantity : null;
}

function getOrderStatus(orderId) {
  const res = http.get(`${BASE_URL}/api/orders/${orderId}/status`);
  if (res.status !== 200) return null;
  return JSON.parse(res.body).status;
}

export default function () {
  const baselineReserved = getReserved(PRODUCT_ID);
  if (baselineReserved === null) {
    console.error('Could not read baseline inventory');
    ordersFailed.add(1);
    return;
  }

  const payload = JSON.stringify({
    customerId: uuidv4(),
    items: [{ productId: PRODUCT_ID, quantity: 1, unitPrice: 29.99 }],
  });

  const start = Date.now();
  const postRes = http.post(`${BASE_URL}/api/orders`, payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (postRes.status !== 202 || !postRes.body) {
    console.warn(`Order POST failed: status=${postRes.status}`);
    ordersFailed.add(1);
    return;
  }

  const order = JSON.parse(postRes.body);
  const orderId = order.orderId;
  if (!orderId) {
    ordersFailed.add(1);
    return;
  }

  const deadline = start + TIMEOUT_MS;
  let inventoryVisibleAt = null;
  let completionAt       = null;
  let releaseVisibleAt   = null;
  let sawFailure         = false;

  while (Date.now() < deadline) {
    sleep(POLL_INTERVAL_S);

    if (inventoryVisibleAt === null) {
      const current = getReserved(PRODUCT_ID);
      if (current !== null && current > baselineReserved) {
        inventoryVisibleAt = Date.now() - start;
        inventoryLag.add(inventoryVisibleAt);
      }
    }

    const status = getOrderStatus(orderId);
    if (status === 'Completed') {
      completionAt = Date.now() - start;
      sagaCompletionLag.add(completionAt);
      ordersCompleted.add(1);
      break;
    }
    if (status === 'Failed' || status === 'Compensating') {
      sawFailure = true;
      // Continue polling until the reservation is released (inventory returns to baseline)
      const current = getReserved(PRODUCT_ID);
      if (current !== null && current <= baselineReserved && inventoryVisibleAt !== null) {
        releaseVisibleAt = Date.now() - start;
        inventoryReleaseLag.add(releaseVisibleAt);
        break;
      }
    }
  }

  if (!completionAt && !sawFailure) {
    ordersTimedOut.add(1);
    console.warn(`Iteration timed out: orderId=${orderId}`);
  } else if (sawFailure) {
    ordersFailed.add(1);
  }
}

export function handleSummary(data) {
  function pctls(metric) {
    if (!metric || !metric.values) return null;
    const v = metric.values;
    return {
      count: v.count,
      avg:   (v.avg      || 0).toFixed(1),
      med:   (v.med      || 0).toFixed(1),
      p90:   (v['p(90)'] || 0).toFixed(1),
      p95:   (v['p(95)'] || 0).toFixed(1),
      max:   (v.max      || 0).toFixed(1),
    };
  }

  function fmtRow(label, metric) {
    const p = pctls(metric);
    if (!p) return `  ${label}: (no data)`;
    return `  ${label}:\n    n=${p.count}  avg=${p.avg}ms  med=${p.med}ms  p90=${p.p90}ms  p95=${p.p95}ms  max=${p.max}ms`;
  }

  const m         = data.metrics;
  const completed = m.orders_completed  ? m.orders_completed.values.count  : 0;
  const timedOut  = m.orders_timed_out   ? m.orders_timed_out.values.count   : 0;
  const failed    = m.orders_failed      ? m.orders_failed.values.count      : 0;

  const summary = [
    '',
    '═══════════════════════════════════════════════════════════════',
    `  INVENTORY-VISIBILITY LAG — ${MODE.toUpperCase()}`,
    `  Iterations: ${ITERATIONS}  Product: ${PRODUCT_ID}`,
    '═══════════════════════════════════════════════════════════════',
    '',
    `  Orders: ${completed} completed  |  ${failed} failed  |  ${timedOut} timed out`,
    '',
    '  Visibility lag (ms from POST /api/orders):',
    fmtRow('  → reserved stock visible via /api/inventory/products', m.inventory_visibility_lag_ms),
    fmtRow('  → Order.Status = Completed',                            m.saga_completion_lag_ms),
    fmtRow('  → stock released (failure path only)',                  m.inventory_release_lag_ms),
    '',
    '═══════════════════════════════════════════════════════════════',
    '',
  ].join('\n');

  const jsonResult = {
    mode: MODE,
    test: 'inventory_visibility_lag',
    iterations: ITERATIONS,
    productId: PRODUCT_ID,
    totals: { completed, timedOut, failed },
    inventoryVisibilityLagMs: pctls(m.inventory_visibility_lag_ms),
    sagaCompletionLagMs:      pctls(m.saga_completion_lag_ms),
    inventoryReleaseLagMs:    pctls(m.inventory_release_lag_ms),
  };

  return {
    stdout: summary,
    [`results/consistency_${MODE}_${RESULT_STAMP}.json`]: JSON.stringify(jsonResult, null, 2),
    [`results/consistency_${MODE}.json`]: JSON.stringify(jsonResult, null, 2),
  };
}
