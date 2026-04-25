import http from 'k6/http';
import { check, sleep } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { Trend, Counter } from 'k6/metrics';

// =============================================================================
//  Concurrent-Customer Throughput Benchmark
// =============================================================================
//
// All VUs fire orders simultaneously; each VU picks a DIFFERENT product from
// the plenty-stock pool so there is no row-level contention on ReservedQuantity.
// This isolates pure pipeline parallelism (HTTP handlers, Temporal workers,
// MassTransit consumers, DB connection pools) from the row-locking overhead
// that race-condition.js intentionally stresses.
//
// The happy-path saga throughput should scale roughly linearly with VUs up to
// the first bottleneck (usually Temporal's history DB or RabbitMQ). Compare
// this curve against benchmark-race-condition.js to quantify the cost of
// contention.
//
// Usage:
//   k6 run --env MODE=orchestration --env VUS=50 --env DURATION=30s \
//     benchmark-concurrent-customers.js

const totalSagaDuration = new Trend('total_saga_duration_ms', true);
const apiResponseTime   = new Trend('api_response_ms',        true);
const ordersCompleted   = new Counter('orders_completed');
const ordersFailed      = new Counter('orders_failed');

const VUS         = __ENV.VUS        ? parseInt(__ENV.VUS) : 50;
const DURATION    = __ENV.DURATION   || '30s';
const BASE_URL    = __ENV.BASE_URL   || 'http://localhost:5005';
const MODE        = __ENV.MODE       || 'unknown';
const RESULT_STAMP = new Date().toISOString().replace(/[:.]/g, '-');

// 5 plenty-stock products (100k units each) — each VU picks one by VU index
// so the same VU always hits the same product (reduces cross-product noise
// but still parallelises across the pool).
const PRODUCTS = [
  { productId: 'a1111111-1111-1111-1111-111111111111', unitPrice: 29.99 },
  { productId: 'a2222222-2222-2222-2222-222222222222', unitPrice: 89.99 },
  { productId: 'a3333333-3333-3333-3333-333333333333', unitPrice: 49.99 },
  { productId: 'a4444444-4444-4444-4444-444444444444', unitPrice: 39.99 },
  { productId: 'a5555555-5555-5555-5555-555555555555', unitPrice: 59.99 },
];

export const options = {
  scenarios: {
    parallel: {
      executor: 'constant-vus',    // each VU hammers in a tight loop
      vus: VUS,
      duration: DURATION,
    },
  },
  thresholds: {
    total_saga_duration_ms: ['p(95)<15000'],
  },
};

export function setup() {
  http.post(`${BASE_URL}/api/inventory/reset`);
  http.del(`${BASE_URL}/api/orders/reset`);
  http.post(`${BASE_URL}/api/payments/failure-rate/0`);
  sleep(2);
  console.log('[setup] State reset complete');
}

export default function () {
  // Distribute VUs across products so concurrent sagas don't all touch the same row.
  const product = PRODUCTS[__VU % PRODUCTS.length];

  const payload = JSON.stringify({
    customerId: uuidv4(),
    items: [{ productId: product.productId, quantity: 1, unitPrice: product.unitPrice }],
  });

  const res = http.post(`${BASE_URL}/api/orders/benchmark`, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '35s',
  });

  if (!check(res, { 'status is 200': (r) => r.status === 200 })) {
    ordersFailed.add(1);
    return;
  }

  const data = JSON.parse(res.body);
  apiResponseTime.add(data.apiResponseMs);
  totalSagaDuration.add(data.totalSagaDurationMs);

  if (data.finalStatus === 'Completed') {
    ordersCompleted.add(1);
  } else {
    ordersFailed.add(1);
  }
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
      p99: (v['p(99)'] || 0).toFixed(1),
      max: (v.max      || 0).toFixed(1),
    };
  }

  const saga      = pctls(data.metrics.total_saga_duration_ms);
  const api       = pctls(data.metrics.api_response_ms);
  const completed = data.metrics.orders_completed ? data.metrics.orders_completed.values.count : 0;
  const failed    = data.metrics.orders_failed    ? data.metrics.orders_failed.values.count    : 0;
  const total     = completed + failed;

  // Effective throughput (completed orders per second, over the test window)
  const durSec = (function () {
    const m = /^(\d+)(s|m|h)$/.exec(DURATION);
    if (!m) return 30;
    const n = parseInt(m[1]);
    return m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n;
  })();
  const throughput = (completed / durSec).toFixed(1);

  function fmtRow(label, p) {
    if (!p) return `    ${label}: (no data)`;
    return `    ${label}: n=${p.count}  avg=${p.avg}  p95=${p.p95}  p99=${p.p99}  max=${p.max}`;
  }

  const summary = [
    '',
    '═══════════════════════════════════════════════════════════════',
    `  CONCURRENT CUSTOMERS — ${MODE.toUpperCase()}`,
    `  VUs: ${VUS}  |  Duration: ${DURATION}  |  Products: ${PRODUCTS.length} (VU % N)`,
    '═══════════════════════════════════════════════════════════════',
    '',
    `  Orders: ${completed} completed, ${failed} failed  (total=${total})`,
    `  Effective throughput: ${throughput} completed orders/sec`,
    '',
    '  API Response (ms):',
    fmtRow('api', api),
    '',
    '  Total saga duration (ms):',
    fmtRow('saga', saga),
    '',
    '═══════════════════════════════════════════════════════════════',
    '',
  ].join('\n');

  const jsonResult = {
    mode: MODE,
    test: 'concurrent_customers',
    vus: VUS,
    duration: DURATION,
    totals: { completed, failed },
    effectiveThroughputPerSec: parseFloat(throughput),
    apiResponseMs:       api,
    totalSagaDurationMs: saga,
  };

  return {
    stdout: summary,
    [`results/concurrent_${MODE}_${VUS}vus_${RESULT_STAMP}.json`]: JSON.stringify(jsonResult, null, 2),
    [`results/concurrent_${MODE}_${VUS}vus.json`]: JSON.stringify(jsonResult, null, 2),
  };
}
