import http from 'k6/http';
import { check } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { Trend, Counter } from 'k6/metrics';

// Measures per-step saga duration using the /api/orders/benchmark endpoint
// This endpoint creates an order, polls until completion, and returns step timings

const apiResponseTime = new Trend('api_response_ms', true);
const totalSagaDuration = new Trend('total_saga_duration_ms', true);
const compensationDuration = new Trend('compensation_duration_ms', true);
const ordersCompleted = new Counter('orders_completed');
const ordersFailed = new Counter('orders_failed');
const ordersCompensated = new Counter('orders_compensated');

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
    api_response_ms: ['p(95)<2000'],
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
}

export function handleSummary(data) {
  function pctls(metric) {
    if (!metric || !metric.values) return {};
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

  const apiP = pctls(data.metrics.api_response_ms);
  const sagaP = pctls(data.metrics.total_saga_duration_ms);
  const compP = pctls(data.metrics.compensation_duration_ms);
  const completed = data.metrics.orders_completed ? data.metrics.orders_completed.values.count : 0;
  const failed = data.metrics.orders_failed ? data.metrics.orders_failed.values.count : 0;
  const compensated = data.metrics.orders_compensated ? data.metrics.orders_compensated.values.count : 0;

  const summary = [
    '',
    '═══════════════════════════════════════════════════════════════',
    `  SAGA BENCHMARK RESULTS — ${MODE.toUpperCase()}`,
    `  Rate: ${RATE} req/s | Duration: ${DURATION}`,
    '═══════════════════════════════════════════════════════════════',
    '',
    `  Orders: ${completed} completed, ${failed} failed, ${compensated} compensated`,
    '',
    '  API Response (ms):',
    `    min=${apiP.min}  avg=${apiP.avg}  med=${apiP.med}`,
    `    p90=${apiP.p90}  p95=${apiP.p95}  p99=${apiP.p99}  max=${apiP.max}`,
    '',
    '  Total Saga Duration (ms):',
    `    min=${sagaP.min}  avg=${sagaP.avg}  med=${sagaP.med}`,
    `    p90=${sagaP.p90}  p95=${sagaP.p95}  p99=${sagaP.p99}  max=${sagaP.max}`,
    '',
    '  Compensation Duration (ms):',
    compensated > 0
      ? `    min=${compP.min}  avg=${compP.avg}  med=${compP.med}\n    p90=${compP.p90}  p95=${compP.p95}  p99=${compP.p99}  max=${compP.max}`
      : '    (no compensations triggered)',
    '',
    '═══════════════════════════════════════════════════════════════',
    '',
  ].join('\n');

  const jsonResult = {
    mode: MODE,
    rate: parseInt(RATE),
    duration: DURATION,
    totals: { completed, failed, compensated },
    apiResponseMs: pctls(data.metrics.api_response_ms),
    totalSagaDurationMs: pctls(data.metrics.total_saga_duration_ms),
    compensationDurationMs: compensated > 0 ? pctls(data.metrics.compensation_duration_ms) : null,
    rawMetrics: {
      api_response_ms: data.metrics.api_response_ms,
      total_saga_duration_ms: data.metrics.total_saga_duration_ms,
      compensation_duration_ms: data.metrics.compensation_duration_ms,
      orders_completed: data.metrics.orders_completed,
      orders_failed: data.metrics.orders_failed,
      orders_compensated: data.metrics.orders_compensated,
    },
  };

  return {
    stdout: summary,
    [`results/steps_${MODE}_${RATE}rps.json`]: JSON.stringify(jsonResult, null, 2),
  };
}
