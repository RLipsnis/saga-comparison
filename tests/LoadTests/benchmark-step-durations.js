import http from 'k6/http';
import { check } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { Trend, Counter } from 'k6/metrics';

// Measures per-step duration for each saga activity/consumer.
// This is the key test for identifying bottlenecks in each approach
// (e.g., which step is slowest, where does orchestration overhead appear).

const totalSagaDuration = new Trend('total_saga_duration_ms', true);
const stepInventory = new Trend('step_reserve_inventory_ms', true);
const stepPayment = new Trend('step_process_payment_ms', true);
const stepShipping = new Trend('step_arrange_shipping_ms', true);
const stepNotification = new Trend('step_send_notification_ms', true);
const stepUpdateStatus = new Trend('step_update_status_ms', true);
const ordersCompleted = new Counter('orders_completed');
const ordersFailed = new Counter('orders_failed');

const RATE = __ENV.RATE ? parseInt(__ENV.RATE) : 1;
const DURATION = __ENV.DURATION || '60s';
const BASE_URL = __ENV.BASE_URL || 'http://localhost:5005';
const MODE = __ENV.MODE || 'unknown';

const PRODUCTS = [
  { productId: 'a1111111-1111-1111-1111-111111111111', unitPrice: 29.99 },
  { productId: 'a2222222-2222-2222-2222-222222222222', unitPrice: 89.99 },
  { productId: 'a3333333-3333-3333-3333-333333333333', unitPrice: 49.99 },
];

export const options = {
  scenarios: {
    benchmark: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(RATE * 10, 20),
      maxVUs: Math.max(RATE * 30, 100),
    },
  },
  thresholds: {
    total_saga_duration_ms: ['p(95)<10000'],
  },
};

export default function () {
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
  totalSagaDuration.add(data.totalSagaDurationMs);

  if (data.finalStatus === 'Completed') {
    ordersCompleted.add(1);
  } else {
    ordersFailed.add(1);
  }

  // Record per-step durations if available
  if (data.stepDurationsMs) {
    const s = data.stepDurationsMs;
    if (s.reserveInventory !== undefined) stepInventory.add(s.reserveInventory);
    if (s.processPayment !== undefined) stepPayment.add(s.processPayment);
    if (s.arrangeShipping !== undefined) stepShipping.add(s.arrangeShipping);
    if (s.sendNotification !== undefined) stepNotification.add(s.sendNotification);
    if (s.updateStatus !== undefined) stepUpdateStatus.add(s.updateStatus);
  }
}

export function handleSummary(data) {
  function pctls(metric) {
    if (!metric || !metric.values) return null;
    const v = metric.values;
    return {
      min: (v.min || 0).toFixed(1),
      avg: (v.avg || 0).toFixed(1),
      med: (v['med'] || 0).toFixed(1),
      p90: (v['p(90)'] || 0).toFixed(1),
      p95: (v['p(95)'] || 0).toFixed(1),
      p99: (v['p(99)'] || 0).toFixed(1),
      max: (v.max || 0).toFixed(1),
      count: v.count || 0,
    };
  }

  function fmtStep(name, metric) {
    const p = pctls(metric);
    if (!p) return `  ${name}: (no data)`;
    return `  ${name}:\n    avg=${p.avg}  med=${p.med}  p95=${p.p95}  p99=${p.p99}  max=${p.max}`;
  }

  const sagaP = pctls(data.metrics.total_saga_duration_ms);
  const completed = data.metrics.orders_completed ? data.metrics.orders_completed.values.count : 0;
  const failed = data.metrics.orders_failed ? data.metrics.orders_failed.values.count : 0;

  const summary = [
    '',
    '═══════════════════════════════════════════════════════════════',
    `  PER-STEP DURATION RESULTS — ${MODE.toUpperCase()}`,
    `  Rate: ${RATE} req/s | Duration: ${DURATION}`,
    '═══════════════════════════════════════════════════════════════',
    '',
    `  Orders: ${completed} completed, ${failed} failed`,
    '',
    '  Total Saga Duration (ms):',
    sagaP ? `    avg=${sagaP.avg}  med=${sagaP.med}  p95=${sagaP.p95}  p99=${sagaP.p99}  max=${sagaP.max}` : '    (no data)',
    '',
    '  Per-Step Breakdown (ms):',
    fmtStep('Reserve Inventory', data.metrics.step_reserve_inventory_ms),
    fmtStep('Process Payment  ', data.metrics.step_process_payment_ms),
    fmtStep('Arrange Shipping ', data.metrics.step_arrange_shipping_ms),
    fmtStep('Send Notification', data.metrics.step_send_notification_ms),
    fmtStep('Update Status    ', data.metrics.step_update_status_ms),
    '',
    '═══════════════════════════════════════════════════════════════',
    '',
  ].join('\n');

  const jsonResult = {
    mode: MODE,
    rate: parseInt(RATE),
    duration: DURATION,
    totals: { completed, failed },
    totalSagaDurationMs: pctls(data.metrics.total_saga_duration_ms),
    stepDurations: {
      reserveInventory: pctls(data.metrics.step_reserve_inventory_ms),
      processPayment: pctls(data.metrics.step_process_payment_ms),
      arrangeShipping: pctls(data.metrics.step_arrange_shipping_ms),
      sendNotification: pctls(data.metrics.step_send_notification_ms),
      updateStatus: pctls(data.metrics.step_update_status_ms),
    },
  };

  return {
    stdout: summary,
    [`results/step_durations_${MODE}_${RATE}rps.json`]: JSON.stringify(jsonResult, null, 2),
  };
}
