import http from 'k6/http';
import { check } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { Trend, Counter } from 'k6/metrics';

// =============================================================================
//  Endurance / Sustained Load Benchmark
// =============================================================================
//
// Runs at a constant rate for DURATION (default 5 minutes). Splits the run into
// three equal buckets (start / middle / end) so the summary reports P95 drift
// over time — the standard signal for:
//   * queue backlog growth in choreography (RabbitMQ)
//   * Temporal history-table bloat affecting write latency
//   * connection-pool exhaustion
//   * unbounded memory growth in any .NET service
//
// If start-bucket P95 ≈ end-bucket P95, the system is steady-state. If the
// end bucket is visibly worse, you have a leak or backpressure problem.
//
// Usage:
//   k6 run --env MODE=orchestration --env RATE=25 --env DURATION=5m benchmark-endurance.js

const totalSagaDuration = new Trend('total_saga_duration_ms', true);
const apiResponseTime   = new Trend('api_response_ms',        true);
const ordersCompleted   = new Counter('orders_completed');
const ordersFailed      = new Counter('orders_failed');

const RATE     = __ENV.RATE     ? parseInt(__ENV.RATE) : 25;
const DURATION = __ENV.DURATION || '5m';
const BASE_URL = __ENV.BASE_URL || 'http://localhost:5005';
const MODE     = __ENV.MODE     || 'unknown';
const RESULT_STAMP = new Date().toISOString().replace(/[:.]/g, '-');

const PRODUCTS = [
  { productId: 'a1111111-1111-1111-1111-111111111111', unitPrice: 29.99 },
  { productId: 'a2222222-2222-2222-2222-222222222222', unitPrice: 89.99 },
  { productId: 'a3333333-3333-3333-3333-333333333333', unitPrice: 49.99 },
];

// Parse DURATION into seconds for bucket boundaries
function parseDuration(s) {
  const m = /^(\d+)(s|m|h)$/.exec(s);
  if (!m) return 300;
  const n = parseInt(m[1]);
  return m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n;
}
const TOTAL_SECONDS = parseDuration(DURATION);
const TEST_START    = Date.now();

export const options = {
  scenarios: {
    endurance: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(RATE * 2, 10),
      maxVUs: Math.max(RATE * 5, 50),
    },
  },
  thresholds: {
    // k6 only creates submetric entries in data.metrics when a threshold
    // references the tag combination. These are needed so handleSummary can
    // read per-bucket percentiles for the P95-drift calculation.
    'total_saga_duration_ms':                 ['p(95)<10000'],
    'total_saga_duration_ms{bucket:start}':   ['p(95)<15000'],
    'total_saga_duration_ms{bucket:middle}':  ['p(95)<15000'],
    'total_saga_duration_ms{bucket:end}':     ['p(95)<15000'],
  },
};

function currentBucket() {
  const elapsed = (Date.now() - TEST_START) / 1000;
  const third   = TOTAL_SECONDS / 3;
  if (elapsed < third)     return 'start';
  if (elapsed < 2 * third) return 'middle';
  return 'end';
}

export default function () {
  const product = PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)];

  const payload = JSON.stringify({
    customerId: uuidv4(),
    items: [{ productId: product.productId, quantity: 1, unitPrice: product.unitPrice }],
  });

  const bucket = currentBucket();

  const res = http.post(`${BASE_URL}/api/orders/benchmark`, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '35s',
  });

  if (!check(res, { 'status is 200': (r) => r.status === 200 })) {
    ordersFailed.add(1, { bucket });
    return;
  }

  const data = JSON.parse(res.body);
  apiResponseTime.add(data.apiResponseMs,       { bucket });
  totalSagaDuration.add(data.totalSagaDurationMs, { bucket });

  if (data.finalStatus === 'Completed') {
    ordersCompleted.add(1, { bucket });
  } else {
    ordersFailed.add(1, { bucket });
  }
}

export function handleSummary(data) {
  function pctls(metric, tag) {
    const key = tag ? `${metric}{${tag}}` : metric;
    const m   = data.metrics[key] || data.metrics[metric];
    if (!m || !m.values || !m.values.count) return null;
    const v = m.values;
    return {
      count: v.count,
      avg:   (v.avg      || 0).toFixed(1),
      med:   (v.med      || 0).toFixed(1),
      p95:   (v['p(95)'] || 0).toFixed(1),
      p99:   (v['p(99)'] || 0).toFixed(1),
      max:   (v.max      || 0).toFixed(1),
    };
  }

  const overall = pctls('total_saga_duration_ms');
  const start   = pctls('total_saga_duration_ms', 'bucket:start');
  const mid     = pctls('total_saga_duration_ms', 'bucket:middle');
  const end     = pctls('total_saga_duration_ms', 'bucket:end');

  function fmtRow(label, p) {
    if (!p) return `    ${label}: (no data)`;
    return `    ${label}: n=${p.count}  avg=${p.avg}  p95=${p.p95}  p99=${p.p99}  max=${p.max}`;
  }

  // Compute drift: end P95 vs start P95
  const drift = (start && end)
    ? (parseFloat(end.p95) - parseFloat(start.p95)).toFixed(1)
    : 'n/a';

  const summary = [
    '',
    '═══════════════════════════════════════════════════════════════',
    `  ENDURANCE — ${MODE.toUpperCase()}`,
    `  Rate: ${RATE} req/s  |  Duration: ${DURATION}  (3 equal buckets)`,
    '═══════════════════════════════════════════════════════════════',
    '',
    '  Saga duration per time bucket (ms):',
    fmtRow('start ', start),
    fmtRow('middle', mid),
    fmtRow('end   ', end),
    '',
    `  P95 drift (end − start): ${drift} ms`,
    `  ${drift !== 'n/a' && parseFloat(drift) > 500
        ? 'WARNING: visible degradation over time — check queue depths, memory, Temporal history table'
        : 'Steady-state (no visible degradation)'}`,
    '',
    '  Overall:',
    fmtRow('all   ', overall),
    '',
    '═══════════════════════════════════════════════════════════════',
    '',
  ].join('\n');

  const jsonResult = {
    mode: MODE,
    test: 'endurance',
    rate: RATE,
    duration: DURATION,
    overall,
    buckets: { start, middle: mid, end },
    p95DriftMs: drift,
  };

  return {
    stdout: summary,
    [`results/endurance_${MODE}_${RATE}rps_${DURATION}_${RESULT_STAMP}.json`]: JSON.stringify(jsonResult, null, 2),
    [`results/endurance_${MODE}_${RATE}rps.json`]: JSON.stringify(jsonResult, null, 2),
  };
}
