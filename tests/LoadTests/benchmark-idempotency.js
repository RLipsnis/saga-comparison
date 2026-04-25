import http from 'k6/http';
import { check, sleep } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { Counter, Trend } from 'k6/metrics';

// =============================================================================
//  Idempotency Test — double-click behavior on POST /api/orders
// =============================================================================
//
// Sends the same order twice back-to-back using the same IdempotencyKey and
// asserts that:
//   (a) both requests return HTTP 202
//   (b) both responses carry the SAME orderId
//   (c) the server flags the second response with Idempotent: true
//
// If correctness-check (b) fails, a duplicate saga will have been kicked off
// (double charge + double shipment), which is the concrete UX bug this test
// protects against.

const idempotentHits     = new Counter('idempotent_hits');
const duplicateCreated   = new Counter('duplicate_orders_created');
const firstResponseTime  = new Trend('first_response_ms',  true);
const secondResponseTime = new Trend('second_response_ms', true);

const BASE_URL   = __ENV.BASE_URL   || 'http://localhost:5005';
const MODE       = __ENV.MODE       || 'unknown';
const ITERATIONS = __ENV.ITERATIONS ? parseInt(__ENV.ITERATIONS) : 20;
const RESULT_STAMP = new Date().toISOString().replace(/[:.]/g, '-');

export const options = {
  scenarios: {
    idempotency: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: ITERATIONS,
      maxDuration: '5m',
    },
  },
  thresholds: {
    // Test FAILS immediately if any duplicate is created — correctness check.
    duplicate_orders_created: ['count==0'],
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
  const customerId     = uuidv4();
  const idempotencyKey = uuidv4();

  const payload = JSON.stringify({
    customerId,
    idempotencyKey,
    items: [{ productId: 'a1111111-1111-1111-1111-111111111111', quantity: 1, unitPrice: 29.99 }],
  });
  const params = { headers: { 'Content-Type': 'application/json' } };

  // First request
  const t1   = Date.now();
  const res1 = http.post(`${BASE_URL}/api/orders`, payload, params);
  firstResponseTime.add(Date.now() - t1);

  const firstOk = check(res1, { 'first request 202': (r) => r.status === 202 });
  if (!firstOk) return;

  const body1    = JSON.parse(res1.body);
  const orderId1 = body1.orderId;

  // Second request — the "double-click"
  const t2   = Date.now();
  const res2 = http.post(`${BASE_URL}/api/orders`, payload, params);
  secondResponseTime.add(Date.now() - t2);

  const secondOk = check(res2, {
    'second request 202':  (r) => r.status === 202,
    'same orderId':        (r) => r.status === 202 && JSON.parse(r.body).orderId === orderId1,
    'idempotent flag set': (r) => r.status === 202 && JSON.parse(r.body).idempotent === true,
  });

  if (secondOk) {
    idempotentHits.add(1);
  } else {
    const body2 = res2.status === 202 ? JSON.parse(res2.body) : {};
    duplicateCreated.add(1);
    console.warn(`DUPLICATE: first=${orderId1} second=${body2.orderId} flag=${body2.idempotent}`);
  }
}

export function handleSummary(data) {
  const hits       = data.metrics.idempotent_hits        ? data.metrics.idempotent_hits.values.count        : 0;
  const duplicates = data.metrics.duplicate_orders_created ? data.metrics.duplicate_orders_created.values.count : 0;
  const first      = data.metrics.first_response_ms      ? data.metrics.first_response_ms.values      : {};
  const second     = data.metrics.second_response_ms     ? data.metrics.second_response_ms.values     : {};

  const correctness = duplicates === 0 && hits === ITERATIONS
    ? 'PASS (all double-clicks deduplicated)'
    : `FAIL (${duplicates} duplicate orders created out of ${ITERATIONS})`;

  const summary = [
    '',
    '═══════════════════════════════════════════════════════════════',
    `  IDEMPOTENCY — ${MODE.toUpperCase()}`,
    `  Iterations: ${ITERATIONS}`,
    '═══════════════════════════════════════════════════════════════',
    '',
    `  ${correctness}`,
    `  Idempotent hits: ${hits} | Duplicates: ${duplicates}`,
    '',
    `  1st POST (new order)      : avg=${(first.avg||0).toFixed(1)}ms  p95=${(first['p(95)']||0).toFixed(1)}ms`,
    `  2nd POST (cache hit)      : avg=${(second.avg||0).toFixed(1)}ms  p95=${(second['p(95)']||0).toFixed(1)}ms`,
    '',
    '═══════════════════════════════════════════════════════════════',
    '',
  ].join('\n');

  const jsonResult = {
    mode: MODE,
    test: 'idempotency',
    iterations: ITERATIONS,
    idempotentHits: hits,
    duplicatesCreated: duplicates,
    correctness,
    firstResponseMs:  { avg: (first.avg||0).toFixed(1),  p95: (first['p(95)']||0).toFixed(1),  max: (first.max||0).toFixed(1)  },
    secondResponseMs: { avg: (second.avg||0).toFixed(1), p95: (second['p(95)']||0).toFixed(1), max: (second.max||0).toFixed(1) },
  };

  return {
    stdout: summary,
    [`results/idempotency_${MODE}_${RESULT_STAMP}.json`]: JSON.stringify(jsonResult, null, 2),
    [`results/idempotency_${MODE}.json`]: JSON.stringify(jsonResult, null, 2),
  };
}
