import http from 'k6/http';
import { check } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { Counter, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';

// Measures race condition behavior: N concurrent orders for a limited-stock product
// Run with: k6 run --vus 20 --iterations 20 benchmark-race-condition.js

const raceWins = new Counter('race_wins');
const raceLosses = new Counter('race_losses');
const raceResponseTime = new Trend('race_response_ms', true);

const BASE_URL = __ENV.BASE_URL || 'http://localhost:5005';
const MODE = __ENV.MODE || 'unknown';
const VUS = __ENV.VUS ? parseInt(__ENV.VUS) : 20;
// Product with stock=1 (limited edition tablet)
const RACE_PRODUCT = 'c1111111-1111-1111-1111-111111111111';

export const options = {
  scenarios: {
    race: {
      executor: 'shared-iterations',
      vus: VUS,
      iterations: VUS,
      maxDuration: '30s',
    },
  },
};

export function setup() {
  // Reset inventory before race
  http.post(`${BASE_URL}/api/inventory/reset`);
  http.del(`${BASE_URL}/api/orders/reset`);
  console.log(`Race condition test: ${VUS} concurrent orders for 1-stock product`);
}

export default function () {
  const payload = JSON.stringify({
    customerId: uuidv4(),
    items: [{ productId: RACE_PRODUCT, quantity: 1, unitPrice: 999.99 }],
  });

  const start = Date.now();
  const res = http.post(`${BASE_URL}/api/orders/benchmark`, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '35s',
  });
  const elapsed = Date.now() - start;

  raceResponseTime.add(elapsed);

  if (res.status === 200) {
    const data = JSON.parse(res.body);
    if (data.finalStatus === 'Completed') {
      raceWins.add(1);
      console.log(`VU ${__VU}: WON (${elapsed}ms)`);
    } else {
      raceLosses.add(1);
      console.log(`VU ${__VU}: LOST - ${data.failureReason} (${elapsed}ms)`);
    }
  } else {
    raceLosses.add(1);
    console.log(`VU ${__VU}: ERROR ${res.status} (${elapsed}ms)`);
  }
}

export function teardown() {
  // Check final inventory
  const res = http.get(`${BASE_URL}/api/inventory/products`);
  if (res.status === 200) {
    const products = JSON.parse(res.body);
    const tablet = products.find(p => p.id === RACE_PRODUCT);
    if (tablet) {
      console.log(`\nFinal stock: Available=${tablet.availableQuantity}, Reserved=${tablet.reservedQuantity}`);
    }
  }
}

export function handleSummary(data) {
  return {
    stdout: JSON.stringify({
      mode: MODE,
      vus: VUS,
      metrics: {
        race_wins: data.metrics.race_wins,
        race_losses: data.metrics.race_losses,
        race_response_ms: data.metrics.race_response_ms,
      },
    }, null, 2),
    [`results/race_${MODE}_${VUS}vus.json`]: JSON.stringify(data, null, 2),
  };
}
