import http from 'k6/http';
import { check } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { Trend, Counter } from 'k6/metrics';

// =============================================================================
//  Mixed-Workload Benchmark — realistic happy + compensation distribution
// =============================================================================
//
// Pre-test hook bumps PaymentService's failure rate to FAIL_RATE_PCT (default 10%).
// Post-test hook resets it to 0. During the run, ~FAIL_RATE_PCT% of orders are
// forced to compensate; the rest succeed. k6 tags each sample with
// `outcome:happy` or `outcome:compensation` so we can extract percentiles for
// each path from a single run — which is a much more realistic picture than
// the pure 0%/100% benchmarks.
//
// Use this to answer: "When 1 in 10 orders rolls back, what do BOTH paths look
// like under production-style mixed traffic?"
//
// Usage:
//   k6 run --env MODE=orchestration --env RATE=10 --env DURATION=60s benchmark-mixed-workload.js

const apiResponseTime      = new Trend('api_response_ms',           true);
const totalSagaDuration    = new Trend('total_saga_duration_ms',    true);
const compensationDuration = new Trend('compensation_duration_ms',  true);
const ordersCompleted      = new Counter('orders_completed');
const ordersCompensated    = new Counter('orders_compensated');
const ordersFailed         = new Counter('orders_failed');

const RATE          = __ENV.RATE     ? parseInt(__ENV.RATE)     : 10;
const DURATION      = __ENV.DURATION || '60s';
const WARMUP        = __ENV.WARMUP   || '5s';
const BASE_URL      = __ENV.BASE_URL || 'http://localhost:5005';
const MODE          = __ENV.MODE     || 'unknown';
const FAIL_RATE_PCT = __ENV.FAIL_RATE_PCT ? parseInt(__ENV.FAIL_RATE_PCT) : 10;
const RESULT_STAMP  = new Date().toISOString().replace(/[:.]/g, '-');

const PRODUCTS = [
  { productId: 'a1111111-1111-1111-1111-111111111111', unitPrice: 29.99 },
  { productId: 'a2222222-2222-2222-2222-222222222222', unitPrice: 89.99 },
  { productId: 'a3333333-3333-3333-3333-333333333333', unitPrice: 49.99 },
];

export const options = {
  scenarios: {
    mixed: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      startTime: WARMUP,
      preAllocatedVUs: Math.max(RATE * 2, 10),
      maxVUs: Math.max(RATE * 5, 50),
      exec: 'placeOrder',
      tags: { phase: 'main' },
    },
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
  },
  thresholds: {
    'total_saga_duration_ms{phase:main,outcome:happy}':        ['p(95)<10000'],
    'compensation_duration_ms{phase:main,outcome:compensation}': ['p(95)<10000'],
  },
};

export function setup() {
  // Flip payments to the target failure rate for the duration of this test.
  const res = http.post(`${BASE_URL}/api/payments/failure-rate/${FAIL_RATE_PCT}`);
  if (res.status !== 200) {
    throw new Error(`Failed to set payment failure rate: ${res.status} ${res.body}`);
  }
  console.log(`[setup] PaymentService FailureRatePercent = ${FAIL_RATE_PCT}`);
  return { originalRate: FAIL_RATE_PCT };
}

export function teardown() {
  // Restore to 0 (happy-path default) so subsequent benchmarks aren't contaminated.
  http.post(`${BASE_URL}/api/payments/failure-rate/0`);
  console.log('[teardown] PaymentService FailureRatePercent reset to 0');
}

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

  if (!check(res, { 'status is 200': (r) => r.status === 200 })) {
    ordersFailed.add(1);
    return;
  }

  const data    = JSON.parse(res.body);
  const outcome = data.compensated ? 'compensation' : 'happy';

  apiResponseTime.add(data.apiResponseMs,                                   { outcome });
  totalSagaDuration.add(data.totalSagaDurationMs,                           { outcome });

  if (data.compensated && data.compensationDurationMs !== null) {
    compensationDuration.add(data.compensationDurationMs, { outcome: 'compensation' });
    ordersCompensated.add(1);
  } else if (data.finalStatus === 'Completed') {
    ordersCompleted.add(1);
  } else {
    ordersFailed.add(1);
  }
}

export default function () { placeOrder(); }

export function handleSummary(data) {
  function pctls(metric, tagFilter) {
    // k6 exposes submetrics as e.g. metrics['total_saga_duration_ms{outcome:happy}']
    const key  = tagFilter ? `${metric}{${tagFilter}}` : metric;
    const m    = data.metrics[key] || data.metrics[metric];
    if (!m || !m.values || !m.values.count) return null;
    const v = m.values;
    return {
      count: v.count,
      avg: (v.avg      || 0).toFixed(1),
      med: (v.med      || 0).toFixed(1),
      p95: (v['p(95)'] || 0).toFixed(1),
      p99: (v['p(99)'] || 0).toFixed(1),
      max: (v.max      || 0).toFixed(1),
    };
  }

  const happy = pctls('total_saga_duration_ms',    'outcome:happy');
  const comp  = pctls('compensation_duration_ms',  'outcome:compensation');

  const completed   = data.metrics.orders_completed   ? data.metrics.orders_completed.values.count   : 0;
  const compensated = data.metrics.orders_compensated ? data.metrics.orders_compensated.values.count : 0;
  const failed      = data.metrics.orders_failed      ? data.metrics.orders_failed.values.count      : 0;
  const total       = completed + compensated + failed;
  const actualFailRate = total ? ((compensated + failed) / total * 100).toFixed(1) : '0.0';

  function fmtRow(label, p) {
    if (!p) return `    ${label}: (no data)`;
    return `    ${label}: n=${p.count}  avg=${p.avg}  med=${p.med}  p95=${p.p95}  p99=${p.p99}  max=${p.max}`;
  }

  const summary = [
    '',
    '═══════════════════════════════════════════════════════════════',
    `  MIXED WORKLOAD — ${MODE.toUpperCase()}`,
    `  Rate: ${RATE} req/s  |  Duration: ${DURATION}  |  Target fail rate: ${FAIL_RATE_PCT}%`,
    '═══════════════════════════════════════════════════════════════',
    '',
    `  Orders: ${completed} completed, ${compensated} compensated, ${failed} failed`,
    `  Observed fail rate: ${actualFailRate}%`,
    '',
    '  Happy-path saga duration (ms):',
    fmtRow('total', happy),
    '',
    '  Compensation-path duration (ms):',
    fmtRow('compensation window', comp),
    '',
    '═══════════════════════════════════════════════════════════════',
    '',
  ].join('\n');

  const jsonResult = {
    mode: MODE,
    test: 'mixed_workload',
    rate: RATE,
    duration: DURATION,
    targetFailRatePercent: FAIL_RATE_PCT,
    observedFailRatePercent: parseFloat(actualFailRate),
    totals: { completed, compensated, failed },
    happyPathMs:    happy,
    compensationMs: comp,
  };

  return {
    stdout: summary,
    [`results/mixed_${MODE}_${RATE}rps_fr${FAIL_RATE_PCT}_${RESULT_STAMP}.json`]: JSON.stringify(jsonResult, null, 2),
    [`results/mixed_${MODE}_${RATE}rps.json`]: JSON.stringify(jsonResult, null, 2),
  };
}
