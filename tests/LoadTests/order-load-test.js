import http from 'k6/http';
import { check, sleep } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { Trend, Counter, Rate } from 'k6/metrics';

// Custom metrics
const orderDuration = new Trend('order_creation_duration', true);
const ordersCreated = new Counter('orders_created');
const ordersFailed = new Counter('orders_failed');
const orderSuccessRate = new Rate('order_success_rate');

// --- CONFIGURATION ---
// Override via CLI: k6 run --env RATE=10 --env DURATION=30s order-load-test.js
const RATE = __ENV.RATE ? parseInt(__ENV.RATE) : 1;           // orders per second
const DURATION = __ENV.DURATION || '30s';                      // test duration
const BASE_URL = __ENV.BASE_URL || 'http://localhost:5005';    // API Gateway

// Products with plenty of stock for sustained load
const PRODUCTS = [
  { productId: 'a1111111-1111-1111-1111-111111111111', unitPrice: 29.99 },
  { productId: 'a2222222-2222-2222-2222-222222222222', unitPrice: 89.99 },
  { productId: 'a3333333-3333-3333-3333-333333333333', unitPrice: 49.99 },
  { productId: 'a4444444-4444-4444-4444-444444444444', unitPrice: 39.99 },
  { productId: 'a5555555-5555-5555-5555-555555555555', unitPrice: 59.99 },
];

export const options = {
  scenarios: {
    constant_rate: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(RATE * 2, 10),
      maxVUs: Math.max(RATE * 5, 50),
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<5000'],
    order_creation_duration: ['p(95)<5000'],
    order_success_rate: ['rate>0.90'],
  },
};

export default function () {
  const product = PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)];
  const quantity = Math.floor(Math.random() * 3) + 1;

  const payload = JSON.stringify({
    customerId: uuidv4(),
    items: [
      {
        productId: product.productId,
        quantity: quantity,
        unitPrice: product.unitPrice,
      },
    ],
  });

  const params = {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'create_order' },
  };

  const res = http.post(`${BASE_URL}/api/orders`, payload, params);

  const success = check(res, {
    'status is 202': (r) => r.status === 202,
    'has orderId': (r) => {
      try { return JSON.parse(r.body).orderId !== undefined; }
      catch { return false; }
    },
  });

  orderDuration.add(res.timings.duration);

  if (success) {
    ordersCreated.add(1);
    orderSuccessRate.add(1);
  } else {
    ordersFailed.add(1);
    orderSuccessRate.add(0);
    console.warn(`Failed order: ${res.status} ${res.body}`);
  }
}

export function handleSummary(data) {
  const rate = RATE;
  const duration = DURATION;
  const mode = __ENV.MODE || 'unknown';

  const httpDur = data.metrics.http_req_duration || {};
  const orderDur = data.metrics.order_creation_duration || {};

  // Extract percentile values from Trend metric
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

  const hp = pctls(httpDur);
  const op = pctls(orderDur);
  const successRate = data.metrics.order_success_rate
    ? (data.metrics.order_success_rate.values.rate * 100).toFixed(1)
    : 'N/A';
  const created = data.metrics.orders_created ? data.metrics.orders_created.values.count : 0;
  const failed = data.metrics.orders_failed ? data.metrics.orders_failed.values.count : 0;

  const summary = [
    '',
    '═══════════════════════════════════════════════════════════════',
    `  LOAD TEST RESULTS — ${mode.toUpperCase()}`,
    `  Rate: ${rate} req/s | Duration: ${duration}`,
    '═══════════════════════════════════════════════════════════════',
    '',
    `  Orders: ${created} created, ${failed} failed (${successRate}% success)`,
    '',
    '  HTTP Request Duration (ms):',
    `    min=${hp.min}  avg=${hp.avg}  med=${hp.med}`,
    `    p90=${hp.p90}  p95=${hp.p95}  p99=${hp.p99}  max=${hp.max}`,
    '',
    '  Order Creation Duration (ms):',
    `    min=${op.min}  avg=${op.avg}  med=${op.med}`,
    `    p90=${op.p90}  p95=${op.p95}  p99=${op.p99}  max=${op.max}`,
    '',
    '═══════════════════════════════════════════════════════════════',
    '',
  ].join('\n');

  const jsonResult = {
    mode,
    rate: parseInt(rate),
    duration,
    totals: { created, failed, successRatePercent: parseFloat(successRate) },
    httpReqDuration: pctls(httpDur),
    orderCreationDuration: pctls(orderDur),
    rawMetrics: {
      http_req_duration: httpDur,
      order_creation_duration: orderDur,
      orders_created: data.metrics.orders_created,
      orders_failed: data.metrics.orders_failed,
      order_success_rate: data.metrics.order_success_rate,
      iterations: data.metrics.iterations,
    },
  };

  return {
    stdout: summary,
    [`results/result_${mode}_${rate}rps.json`]: JSON.stringify(jsonResult, null, 2),
  };
}
