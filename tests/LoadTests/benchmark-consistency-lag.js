import http from 'k6/http';
import { sleep } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { Trend, Counter } from 'k6/metrics';

// Measures per-step consistency lag by polling GET /api/orders/{id}/status after placing an order.
//
// Two sets of metrics:
//  - Cumulative lag: time from order POST until that step became visible (e.g. how long until payment was visible)
//  - Per-step duration: time each individual step took (step N completed - step N-1 completed)
//
// Saga steps in order:
//   Pending → InventoryReserved → PaymentProcessed → ShippingArranged → Completed

// Cumulative lags from order POST
const lagInventoryReserved = new Trend('lag_inventory_reserved_ms', true);
const lagPaymentProcessed  = new Trend('lag_payment_processed_ms',  true);
const lagShippingArranged  = new Trend('lag_shipping_arranged_ms',  true);
const lagTotalSaga         = new Trend('lag_total_saga_ms',          true);

// Per-step deltas (step-to-step duration)
const stepInventory = new Trend('step_reserve_inventory_ms', true);
const stepPayment   = new Trend('step_process_payment_ms',   true);
const stepShipping  = new Trend('step_arrange_shipping_ms',  true);
const stepFinalize  = new Trend('step_finalize_ms',          true);

const ordersCompleted = new Counter('orders_completed');
const ordersTimedOut  = new Counter('orders_timed_out');
const ordersFailed    = new Counter('orders_failed');

const BASE_URL   = __ENV.BASE_URL   || 'http://localhost:5005';
const MODE       = __ENV.MODE       || 'unknown';
const ITERATIONS = __ENV.ITERATIONS ? parseInt(__ENV.ITERATIONS) : 20;
const PRODUCT_ID = 'a1111111-1111-1111-1111-111111111111';

const POLL_INTERVAL_S = 0.05;  // poll status every 50ms
const TIMEOUT_MS      = 15000; // give up after 15s

// Statuses in saga order — if a poll skips a status we backfill with current timestamp
const STATUS_ORDER = ['InventoryReserved', 'PaymentProcessed', 'ShippingArranged', 'Completed'];

export const options = {
  scenarios: {
    consistency: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: ITERATIONS,
      maxDuration: '10m',
    },
  },
};

export default function () {
  const payload = JSON.stringify({
    customerId: uuidv4(),
    items: [{ productId: PRODUCT_ID, quantity: 1, unitPrice: 29.99 }],
  });

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
    console.error(`No orderId in response: ${postRes.body}`);
    ordersFailed.add(1);
    return;
  }

  const start    = Date.now();
  const deadline = start + TIMEOUT_MS;
  const timestamps = {}; // status → ms elapsed since order POST

  while (Date.now() < deadline) {
    sleep(POLL_INTERVAL_S);

    const poll = http.get(`${BASE_URL}/api/orders/${orderId}/status`);
    if (poll.status !== 200 || !poll.body) continue;

    const { status } = JSON.parse(poll.body);
    if (!status) continue;

    const elapsed   = Date.now() - start;
    const statusIdx = STATUS_ORDER.indexOf(status);

    if (statusIdx >= 0) {
      // Backfill any skipped intermediate steps with the current timestamp (conservative estimate)
      for (let i = 0; i <= statusIdx; i++) {
        if (!timestamps[STATUS_ORDER[i]]) timestamps[STATUS_ORDER[i]] = elapsed;
      }
      if (status === 'Completed') break;
    }

    if (status === 'Failed' || status === 'Compensating') {
      ordersFailed.add(1);
      return;
    }
  }

  if (!timestamps['Completed']) {
    ordersTimedOut.add(1);
    console.warn(`Saga did not complete within ${TIMEOUT_MS}ms`);
    return;
  }

  ordersCompleted.add(1);

  // Cumulative lags from order POST
  lagInventoryReserved.add(timestamps['InventoryReserved']);
  lagPaymentProcessed.add(timestamps['PaymentProcessed']);
  lagShippingArranged.add(timestamps['ShippingArranged']);
  lagTotalSaga.add(timestamps['Completed']);

  // Per-step durations (step-to-step deltas)
  stepInventory.add(timestamps['InventoryReserved']);
  stepPayment.add(timestamps['PaymentProcessed']  - timestamps['InventoryReserved']);
  stepShipping.add(timestamps['ShippingArranged'] - timestamps['PaymentProcessed']);
  stepFinalize.add(timestamps['Completed']        - timestamps['ShippingArranged']);
}

export function handleSummary(data) {
  function pctls(metric) {
    if (!metric || !metric.values) return null;
    const v = metric.values;
    return {
      avg: (v.avg        || 0).toFixed(1),
      med: (v.med        || 0).toFixed(1),
      p90: (v['p(90)']   || 0).toFixed(1),
      p95: (v['p(95)']   || 0).toFixed(1),
      max: (v.max        || 0).toFixed(1),
    };
  }

  function fmtRow(label, metric) {
    const p = pctls(metric);
    if (!p) return `  ${label}: (no data)`;
    return `  ${label}:\n    avg=${p.avg}ms  med=${p.med}ms  p90=${p.p90}ms  p95=${p.p95}ms  max=${p.max}ms`;
  }

  const m         = data.metrics;
  const completed = m.orders_completed ? m.orders_completed.values.count : 0;
  const timedOut  = m.orders_timed_out  ? m.orders_timed_out.values.count  : 0;
  const failed    = m.orders_failed     ? m.orders_failed.values.count     : 0;

  const summary = [
    '',
    '═══════════════════════════════════════════════════════════════',
    `  CONSISTENCY LAG — ${MODE.toUpperCase()}`,
    `  Iterations: ${ITERATIONS}`,
    '═══════════════════════════════════════════════════════════════',
    '',
    `  Orders: ${completed} completed  |  ${timedOut} timed out  |  ${failed} failed`,
    '',
    '  Cumulative lag from order POST (ms):',
    '  (how long until each step became externally visible)',
    fmtRow('  1. → Inventory Reserved', m.lag_inventory_reserved_ms),
    fmtRow('  2. → Payment Processed ', m.lag_payment_processed_ms),
    fmtRow('  3. → Shipping Arranged ', m.lag_shipping_arranged_ms),
    fmtRow('  4. → Saga Completed    ', m.lag_total_saga_ms),
    '',
    '  Per-step duration (ms):',
    '  (time each step took relative to the previous step)',
    fmtRow('  Step 1: Reserve Inventory  (Pending → InventoryReserved)', m.step_reserve_inventory_ms),
    fmtRow('  Step 2: Process Payment    (InventoryReserved → PaymentProcessed)', m.step_process_payment_ms),
    fmtRow('  Step 3: Arrange Shipping   (PaymentProcessed → ShippingArranged)', m.step_arrange_shipping_ms),
    fmtRow('  Step 4: Finalize & Notify  (ShippingArranged → Completed)', m.step_finalize_ms),
    '',
    '═══════════════════════════════════════════════════════════════',
    '',
  ].join('\n');

  const jsonResult = {
    mode: MODE,
    test: 'consistency_lag',
    iterations: ITERATIONS,
    totals: { completed, timedOut, failed },
    cumulativeLagMs: {
      description: 'Time (ms) from order POST until each step became visible via status API',
      inventoryReserved: pctls(m.lag_inventory_reserved_ms),
      paymentProcessed:  pctls(m.lag_payment_processed_ms),
      shippingArranged:  pctls(m.lag_shipping_arranged_ms),
      sagaCompleted:     pctls(m.lag_total_saga_ms),
    },
    stepDurationsMs: {
      description: 'Time (ms) each individual step took (delta from previous step completion)',
      reserveInventory:  pctls(m.step_reserve_inventory_ms),
      processPayment:    pctls(m.step_process_payment_ms),
      arrangeShipping:   pctls(m.step_arrange_shipping_ms),
      finalizeAndNotify: pctls(m.step_finalize_ms),
    },
  };

  return {
    stdout: summary,
    [`results/consistency_${MODE}.json`]: JSON.stringify(jsonResult, null, 2),
  };
}
