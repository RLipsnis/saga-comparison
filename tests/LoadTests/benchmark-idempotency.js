import http from 'k6/http';
import { check } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { Counter, Trend } from 'k6/metrics';

// Measures idempotency behavior: send the same order twice and verify no double-processing
// Tests the "button deactivation" UI strategy — what happens on double-click?

const idempotentHits = new Counter('idempotent_hits');
const duplicateCreated = new Counter('duplicate_orders_created');
const firstResponseTime = new Trend('first_response_ms', true);
const secondResponseTime = new Trend('second_response_ms', true);

const BASE_URL = __ENV.BASE_URL || 'http://localhost:5005';
const MODE = __ENV.MODE || 'unknown';
const ITERATIONS = __ENV.ITERATIONS ? parseInt(__ENV.ITERATIONS) : 20;

export const options = {
  scenarios: {
    idempotency: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: ITERATIONS,
      maxDuration: '5m',
    },
  },
};

export default function () {
  const customerId = uuidv4();
  const idempotencyKey = uuidv4();

  const payload = JSON.stringify({
    customerId,
    idempotencyKey,
    items: [{ productId: 'a1111111-1111-1111-1111-111111111111', quantity: 1, unitPrice: 29.99 }],
  });
  const params = { headers: { 'Content-Type': 'application/json' } };

  // First request
  const t1 = Date.now();
  const res1 = http.post(`${BASE_URL}/api/orders`, payload, params);
  firstResponseTime.add(Date.now() - t1);

  check(res1, { 'first request 202': (r) => r.status === 202 });
  const orderId1 = res1.status === 202 ? JSON.parse(res1.body).orderId : null;

  // Immediate "double-click" — same request again
  const t2 = Date.now();
  const res2 = http.post(`${BASE_URL}/api/orders`, payload, params);
  secondResponseTime.add(Date.now() - t2);

  if (res2.status === 202) {
    const orderId2 = JSON.parse(res2.body).orderId;
    if (orderId2 === orderId1) {
      idempotentHits.add(1);
    } else {
      duplicateCreated.add(1);
      console.warn(`DUPLICATE: ${orderId1} vs ${orderId2}`);
    }
  } else {
    // Non-202 on second request could mean idempotency rejection
    idempotentHits.add(1);
  }
}

export function handleSummary(data) {
  return {
    stdout: JSON.stringify({
      mode: MODE,
      test: 'idempotency',
      metrics: {
        idempotent_hits: data.metrics.idempotent_hits,
        duplicate_orders_created: data.metrics.duplicate_orders_created,
        first_response_ms: data.metrics.first_response_ms,
        second_response_ms: data.metrics.second_response_ms,
      },
    }, null, 2),
    [`results/idempotency_${MODE}.json`]: JSON.stringify(data, null, 2),
  };
}
