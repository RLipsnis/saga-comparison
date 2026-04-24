import { useState, useCallback } from 'react'
import { api } from '../api'
import { StatusBadge } from '../components/StatusBadge'

interface BenchmarkResult {
  orderId: string
  sagaMode: string
  finalStatus: string
  failureReason: string | null
  apiResponseMs: number
  totalSagaDurationMs: number
  compensated: boolean
  compensationDurationMs: number | null
  stepTransitions: Record<string, number>
}

interface ConsistencyResult {
  orderIndex: number
  stockBefore: number
  stockAfter: number
  lagMs: number
  orderStatus: string
}

interface RaceRunResult {
  concurrency: number
  wins: number
  losses: number
  results: Array<{
    customerId: string
    status: string
    timeMs: number
  }>
}

interface IdempotencyResult {
  firstStatus: number
  firstOrderId: string | null
  secondStatus: number
  secondOrderId: string | null
  isDuplicate: boolean
  firstMs: number
  secondMs: number
}

type TestResults = {
  sagaSteps: BenchmarkResult[]
  consistencyLag: ConsistencyResult[]
  raceCondition: RaceRunResult | null
  idempotency: IdempotencyResult[]
  compensation: BenchmarkResult[]
}

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function downloadCsv(rows: Record<string, unknown>[], filename: string) {
  if (rows.length === 0) return
  const headers = Object.keys(rows[0])
  const csv = [
    headers.join(','),
    ...rows.map(r => headers.map(h => JSON.stringify(r[h] ?? '')).join(','))
  ].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function avg(arr: number[]): string {
  if (arr.length === 0) return '—'
  return (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)
}

function p95(arr: number[]): string {
  if (arr.length === 0) return '—'
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * 0.95)].toFixed(1)
}

interface Props {
  onError: (msg: string) => void
  sagaMode: string
}

export function ComparisonTab({ onError, sagaMode }: Props) {
  const [running, setRunning] = useState<string | null>(null)
  const [sampleSize, setSampleSize] = useState(10)
  const [raceConcurrency, setRaceConcurrency] = useState(10)
  const [results, setResults] = useState<TestResults>({
    sagaSteps: [],
    consistencyLag: [],
    raceCondition: null,
    idempotency: [],
    compensation: [],
  })

  // ──── TEST 1: Saga Step Duration ────
  const runSagaSteps = useCallback(async () => {
    setRunning('sagaSteps')
    const collected: BenchmarkResult[] = []
    try {
      for (let i = 0; i < sampleSize; i++) {
        const res = await fetch('/api/orders/benchmark', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customerId: crypto.randomUUID(),
            items: [{ productId: 'a1111111-1111-1111-1111-111111111111', quantity: 1, unitPrice: 29.99 }],
          }),
        })
        if (!res.ok) { onError(`Benchmark ${i + 1} failed: ${res.status}`); continue }
        const data = await res.json() as BenchmarkResult
        console.log(`[Benchmark ${i + 1}/${sampleSize}]`, data)
        collected.push(data)
        setResults(prev => ({ ...prev, sagaSteps: [...collected] }))
      }
    } catch (e: any) { onError(e.message) }
    setRunning(null)
  }, [sampleSize, onError])

  // ──── TEST 2: Consistency Lag ────
  const runConsistencyLag = useCallback(async () => {
    setRunning('consistency')
    const collected: ConsistencyResult[] = []
    try {
      for (let i = 0; i < sampleSize; i++) {
        // Get stock before
        const products = await api.getProducts()
        const product = products.find(p => p.id === 'a2222222-2222-2222-2222-222222222222')
        if (!product) { onError('Product not found'); break }
        const stockBefore = product.availableQuantity

        // Create order (fire-and-forget)
        const orderRes = await fetch('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customerId: crypto.randomUUID(),
            items: [{ productId: product.id, quantity: 1, unitPrice: product.price }],
          }),
        })
        const orderTime = performance.now()
        if (!orderRes.ok) { onError(`Order ${i + 1} failed`); continue }

        // Poll inventory until stock decreases
        let lagMs = -1
        for (let j = 0; j < 200; j++) {
          await new Promise(r => setTimeout(r, 100))
          const poll = await api.getProducts()
          const current = poll.find(p => p.id === product.id)
          if (current && current.availableQuantity < stockBefore) {
            lagMs = Math.round(performance.now() - orderTime)
            collected.push({
              orderIndex: i + 1,
              stockBefore,
              stockAfter: current.availableQuantity,
              lagMs,
              orderStatus: 'Completed',
            })
            break
          }
        }
        if (lagMs === -1) {
          collected.push({ orderIndex: i + 1, stockBefore, stockAfter: stockBefore, lagMs: -1, orderStatus: 'Timeout' })
        }
        setResults(prev => ({ ...prev, consistencyLag: [...collected] }))
      }
    } catch (e: any) { onError(e.message) }
    setRunning(null)
  }, [sampleSize, onError])

  // ──── TEST 3: Race Condition ────
  const runRaceCondition = useCallback(async () => {
    setRunning('race')
    try {
      await api.resetInventory()
      await api.resetOrders()
      await new Promise(r => setTimeout(r, 1000))

      const promises = Array.from({ length: raceConcurrency }, async (_, i) => {
        const cid = crypto.randomUUID()
        const start = performance.now()
        try {
          const res = await fetch('/api/orders/benchmark', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              customerId: cid,
              items: [{ productId: 'c1111111-1111-1111-1111-111111111111', quantity: 1, unitPrice: 999.99 }],
            }),
          })
          const elapsed = Math.round(performance.now() - start)
          if (res.ok) {
            const data = await res.json()
            return { customerId: cid.substring(0, 8), status: data.finalStatus ?? 'Unknown', timeMs: elapsed }
          }
          return { customerId: cid.substring(0, 8), status: `Error ${res.status}`, timeMs: elapsed }
        } catch {
          return { customerId: cid.substring(0, 8), status: 'Network Error', timeMs: Math.round(performance.now() - start) }
        }
      })

      const all = await Promise.all(promises)
      const wins = all.filter(r => r.status === 'Completed').length
      const losses = all.length - wins
      setResults(prev => ({
        ...prev,
        raceCondition: { concurrency: raceConcurrency, wins, losses, results: all },
      }))
    } catch (e: any) { onError(e.message) }
    setRunning(null)
  }, [raceConcurrency, onError])

  // ──── TEST 4: Idempotency (Double-Click) ────
  const runIdempotency = useCallback(async () => {
    setRunning('idempotency')
    const collected: IdempotencyResult[] = []
    try {
      for (let i = 0; i < sampleSize; i++) {
        const payload = JSON.stringify({
          customerId: crypto.randomUUID(),
          items: [{ productId: 'a3333333-3333-3333-3333-333333333333', quantity: 1, unitPrice: 49.99 }],
        })
        const opts = { method: 'POST' as const, headers: { 'Content-Type': 'application/json' }, body: payload }

        const t1 = performance.now()
        const res1 = await fetch('/api/orders', opts)
        const firstMs = Math.round(performance.now() - t1)
        const body1 = res1.ok ? await res1.json() : null

        // Immediate "double-click"
        const t2 = performance.now()
        const res2 = await fetch('/api/orders', { ...opts, body: payload })
        const secondMs = Math.round(performance.now() - t2)
        const body2 = res2.ok ? await res2.json() : null

        collected.push({
          firstStatus: res1.status,
          firstOrderId: body1?.orderId ?? null,
          secondStatus: res2.status,
          secondOrderId: body2?.orderId ?? null,
          isDuplicate: body1?.orderId !== body2?.orderId && res2.status === 202,
          firstMs,
          secondMs,
        })
        setResults(prev => ({ ...prev, idempotency: [...collected] }))
      }
    } catch (e: any) { onError(e.message) }
    setRunning(null)
  }, [sampleSize, onError])

  // ──── TEST 5: Compensation ────
  const runCompensation = useCallback(async () => {
    setRunning('compensation')
    const collected: BenchmarkResult[] = []
    try {
      // Set payment failure to 100%
      await api.setFailureRate(100)

      for (let i = 0; i < sampleSize; i++) {
        const res = await fetch('/api/orders/benchmark', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customerId: crypto.randomUUID(),
            items: [{ productId: 'a1111111-1111-1111-1111-111111111111', quantity: 1, unitPrice: 29.99 }],
          }),
        })
        if (!res.ok) { onError(`Compensation test ${i + 1} failed: ${res.status}`); continue }
        const data = await res.json() as BenchmarkResult
        console.log(`[Compensation ${i + 1}/${sampleSize}]`, data)
        collected.push(data)
        setResults(prev => ({ ...prev, compensation: [...collected] }))
      }

      // Restore failure rate to 5%
      await api.setFailureRate(5)
    } catch (e: any) {
      onError(e.message)
      await api.setFailureRate(5).catch(() => {})
    }
    setRunning(null)
  }, [sampleSize, onError])

  // ──── Export ────
  const exportAll = () => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filename = `thesis_${sagaMode}_${timestamp}`
    downloadJson(results, `${filename}.json`)

    if (results.sagaSteps.length > 0) {
      downloadCsv(results.sagaSteps.map(r => ({
        orderId: r.orderId, sagaMode: r.sagaMode, finalStatus: r.finalStatus,
        apiResponseMs: r.apiResponseMs, totalSagaDurationMs: r.totalSagaDurationMs,
        ...r.stepTransitions,
      })), `${filename}_steps.csv`)
    }
    if (results.consistencyLag.length > 0) {
      downloadCsv(results.consistencyLag as any[], `${filename}_lag.csv`)
    }
    if (results.compensation.length > 0) {
      downloadCsv(results.compensation.map(r => ({
        orderId: r.orderId, sagaMode: r.sagaMode, finalStatus: r.finalStatus,
        failureReason: r.failureReason,
        totalSagaDurationMs: r.totalSagaDurationMs,
        compensated: r.compensated,
        compensationDurationMs: r.compensationDurationMs,
        ...r.stepTransitions,
      })), `${filename}_compensation.csv`)
    }
  }

  const sagaDurations = results.sagaSteps.filter(r => r.totalSagaDurationMs > 0).map(r => r.totalSagaDurationMs)
  const apiTimes = results.sagaSteps.map(r => r.apiResponseMs)
  const lags = results.consistencyLag.filter(r => r.lagMs > 0).map(r => r.lagMs)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Thesis Comparison Tests</h2>
          <p className="text-sm text-gray-500">
            Current mode: <span className="font-semibold">{sagaMode}</span> — Run these tests in each mode, then compare exported data.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="text-sm">Sample size:
            <input type="number" min={1} max={100} value={sampleSize}
              onChange={e => setSampleSize(Number(e.target.value))}
              className="ml-2 border rounded px-2 py-1 text-sm w-16" />
          </label>
          <button onClick={exportAll} disabled={results.sagaSteps.length === 0}
            className="px-4 py-1.5 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700 disabled:opacity-50">
            Export All (JSON + CSV)
          </button>
        </div>
      </div>

      {/* ───── TEST 1: Saga Step Durations ───── */}
      <section className="border rounded p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">1. Saga Step Durations</h3>
            <p className="text-xs text-gray-500">Measures API response time (optimistic UI speed) and total saga completion time per step.</p>
          </div>
          <button onClick={runSagaSteps} disabled={running !== null}
            className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">
            {running === 'sagaSteps' ? `Running ${results.sagaSteps.length}/${sampleSize}...` : `Run ${sampleSize} Orders`}
          </button>
        </div>
        {results.sagaSteps.length > 0 && (
          <div className="space-y-2">
            <div className="grid grid-cols-4 gap-3 text-center">
              <div className="bg-blue-50 rounded p-2">
                <div className="text-xs text-gray-500">Avg API Response</div>
                <div className="text-lg font-bold text-blue-700">{avg(apiTimes)}ms</div>
              </div>
              <div className="bg-green-50 rounded p-2">
                <div className="text-xs text-gray-500">Avg Saga Duration</div>
                <div className="text-lg font-bold text-green-700">{avg(sagaDurations)}ms</div>
              </div>
              <div className="bg-orange-50 rounded p-2">
                <div className="text-xs text-gray-500">P95 Saga Duration</div>
                <div className="text-lg font-bold text-orange-700">{p95(sagaDurations)}ms</div>
              </div>
              <div className="bg-gray-50 rounded p-2">
                <div className="text-xs text-gray-500">Success Rate</div>
                <div className="text-lg font-bold">
                  {((results.sagaSteps.filter(r => r.finalStatus === 'Completed').length / results.sagaSteps.length) * 100).toFixed(0)}%
                </div>
              </div>
            </div>
            <table className="w-full text-xs border">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-2 py-1 text-left border-b">#</th>
                  <th className="px-2 py-1 text-left border-b">Status</th>
                  <th className="px-2 py-1 text-right border-b">API (ms)</th>
                  <th className="px-2 py-1 text-right border-b">Total (ms)</th>
                  <th className="px-2 py-1 text-left border-b">Step Transitions (ms from start)</th>
                </tr>
              </thead>
              <tbody>
                {results.sagaSteps.map((r, i) => (
                  <tr key={i}>
                    <td className="px-2 py-1 border-b">{i + 1}</td>
                    <td className="px-2 py-1 border-b"><StatusBadge status={r.finalStatus} /></td>
                    <td className="px-2 py-1 border-b text-right">{r.apiResponseMs}</td>
                    <td className="px-2 py-1 border-b text-right">{r.totalSagaDurationMs}</td>
                    <td className="px-2 py-1 border-b font-mono">
                      {Object.entries(r.stepTransitions).map(([k, v]) => `${k}:${v}`).join(' → ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ───── TEST 2: Consistency Lag ───── */}
      <section className="border rounded p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">2. Eventual Consistency Lag</h3>
            <p className="text-xs text-gray-500">Time between placing order and inventory stock visually updating. Demonstrates stale data indicator need.</p>
          </div>
          <button onClick={runConsistencyLag} disabled={running !== null}
            className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">
            {running === 'consistency' ? `Measuring ${results.consistencyLag.length}/${sampleSize}...` : `Measure ${sampleSize}×`}
          </button>
        </div>
        {results.consistencyLag.length > 0 && (
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="bg-yellow-50 rounded p-2">
                <div className="text-xs text-gray-500">Avg Consistency Lag</div>
                <div className="text-lg font-bold text-yellow-700">{avg(lags)}ms</div>
              </div>
              <div className="bg-red-50 rounded p-2">
                <div className="text-xs text-gray-500">P95 Consistency Lag</div>
                <div className="text-lg font-bold text-red-700">{p95(lags)}ms</div>
              </div>
              <div className="bg-gray-50 rounded p-2">
                <div className="text-xs text-gray-500">Timeouts</div>
                <div className="text-lg font-bold">{results.consistencyLag.filter(r => r.lagMs === -1).length}</div>
              </div>
            </div>
            <table className="w-full text-xs border">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-2 py-1 text-left border-b">#</th>
                  <th className="px-2 py-1 text-right border-b">Stock Before</th>
                  <th className="px-2 py-1 text-right border-b">Stock After</th>
                  <th className="px-2 py-1 text-right border-b">Lag (ms)</th>
                  <th className="px-2 py-1 text-left border-b">Status</th>
                </tr>
              </thead>
              <tbody>
                {results.consistencyLag.map((r, i) => (
                  <tr key={i} className={r.lagMs === -1 ? 'bg-red-50' : ''}>
                    <td className="px-2 py-1 border-b">{r.orderIndex}</td>
                    <td className="px-2 py-1 border-b text-right">{r.stockBefore}</td>
                    <td className="px-2 py-1 border-b text-right">{r.stockAfter}</td>
                    <td className="px-2 py-1 border-b text-right font-mono">{r.lagMs === -1 ? 'TIMEOUT' : r.lagMs}</td>
                    <td className="px-2 py-1 border-b">{r.orderStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ───── TEST 3: Race Condition ───── */}
      <section className="border rounded p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">3. Race Condition (Optimistic Concurrency)</h3>
            <p className="text-xs text-gray-500">N concurrent orders for 1-stock product. Tests concurrency handling differences.</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs">Concurrent:
              <input type="number" min={2} max={50} value={raceConcurrency}
                onChange={e => setRaceConcurrency(Number(e.target.value))}
                className="ml-1 border rounded px-2 py-1 text-xs w-14" />
            </label>
            <button onClick={runRaceCondition} disabled={running !== null}
              className="px-4 py-1.5 bg-amber-500 text-white rounded text-sm hover:bg-amber-600 disabled:opacity-50">
              {running === 'race' ? 'Racing...' : 'Launch Race'}
            </button>
          </div>
        </div>
        {results.raceCondition && (
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="bg-green-50 rounded p-2">
                <div className="text-xs text-gray-500">Winners</div>
                <div className="text-lg font-bold text-green-700">{results.raceCondition.wins}</div>
              </div>
              <div className="bg-red-50 rounded p-2">
                <div className="text-xs text-gray-500">Losers</div>
                <div className="text-lg font-bold text-red-700">{results.raceCondition.losses}</div>
              </div>
              <div className="bg-gray-50 rounded p-2">
                <div className="text-xs text-gray-500">Expected: 1 win, {raceConcurrency - 1} losses</div>
                <div className="text-lg font-bold">
                  {results.raceCondition.wins === 1 ? '✓ Correct' : '✗ Unexpected'}
                </div>
              </div>
            </div>
            <table className="w-full text-xs border">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-2 py-1 text-left border-b">Customer</th>
                  <th className="px-2 py-1 text-left border-b">Status</th>
                  <th className="px-2 py-1 text-right border-b">Time (ms)</th>
                </tr>
              </thead>
              <tbody>
                {results.raceCondition.results.map((r, i) => (
                  <tr key={i} className={r.status === 'Completed' ? 'bg-green-50' : r.status === 'Failed' ? 'bg-red-50' : ''}>
                    <td className="px-2 py-1 border-b font-mono">{r.customerId}</td>
                    <td className="px-2 py-1 border-b">{r.status}</td>
                    <td className="px-2 py-1 border-b text-right">{r.timeMs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ───── TEST 4: Idempotency ───── */}
      <section className="border rounded p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">4. Idempotency (Double-Click Prevention)</h3>
            <p className="text-xs text-gray-500">Sends same order twice immediately. Checks if duplicate orders are created (button deactivation effectiveness).</p>
          </div>
          <button onClick={runIdempotency} disabled={running !== null}
            className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">
            {running === 'idempotency' ? `Testing ${results.idempotency.length}/${sampleSize}...` : `Test ${sampleSize}×`}
          </button>
        </div>
        {results.idempotency.length > 0 && (
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="bg-green-50 rounded p-2">
                <div className="text-xs text-gray-500">Duplicates Prevented</div>
                <div className="text-lg font-bold text-green-700">
                  {results.idempotency.filter(r => !r.isDuplicate).length}
                </div>
              </div>
              <div className="bg-red-50 rounded p-2">
                <div className="text-xs text-gray-500">Duplicates Created</div>
                <div className="text-lg font-bold text-red-700">
                  {results.idempotency.filter(r => r.isDuplicate).length}
                </div>
              </div>
              <div className="bg-gray-50 rounded p-2">
                <div className="text-xs text-gray-500">Avg 2nd Response</div>
                <div className="text-lg font-bold">{avg(results.idempotency.map(r => r.secondMs))}ms</div>
              </div>
            </div>
            <table className="w-full text-xs border">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-2 py-1 text-left border-b">#</th>
                  <th className="px-2 py-1 text-left border-b">1st OrderId</th>
                  <th className="px-2 py-1 text-left border-b">2nd OrderId</th>
                  <th className="px-2 py-1 text-left border-b">Duplicate?</th>
                  <th className="px-2 py-1 text-right border-b">1st (ms)</th>
                  <th className="px-2 py-1 text-right border-b">2nd (ms)</th>
                </tr>
              </thead>
              <tbody>
                {results.idempotency.map((r, i) => (
                  <tr key={i} className={r.isDuplicate ? 'bg-red-50' : ''}>
                    <td className="px-2 py-1 border-b">{i + 1}</td>
                    <td className="px-2 py-1 border-b font-mono">{r.firstOrderId?.substring(0, 8) ?? '—'}...</td>
                    <td className="px-2 py-1 border-b font-mono">{r.secondOrderId?.substring(0, 8) ?? '—'}...</td>
                    <td className="px-2 py-1 border-b">{r.isDuplicate ? '⚠ YES' : '✓ No'}</td>
                    <td className="px-2 py-1 border-b text-right">{r.firstMs}</td>
                    <td className="px-2 py-1 border-b text-right">{r.secondMs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ───── TEST 5: Compensation Timing ───── */}
      <section className="border rounded p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">5. Compensation (Rollback) Timing</h3>
            <p className="text-xs text-gray-500">Forces 100% payment failure to guarantee compensation. Measures how long rollback takes (inventory release after payment decline).</p>
          </div>
          <button onClick={runCompensation} disabled={running !== null}
            className="px-4 py-1.5 bg-red-600 text-white rounded text-sm hover:bg-red-700 disabled:opacity-50">
            {running === 'compensation' ? `Testing ${results.compensation.length}/${sampleSize}...` : `Force ${sampleSize} Failures`}
          </button>
        </div>
        {results.compensation.length > 0 && (() => {
          const compDurations = results.compensation.filter(r => r.compensationDurationMs !== null).map(r => r.compensationDurationMs!)
          const totalDurations = results.compensation.filter(r => r.totalSagaDurationMs > 0).map(r => r.totalSagaDurationMs)
          const allFailed = results.compensation.filter(r => r.finalStatus === 'Failed').length
          const allCompensated = results.compensation.filter(r => r.compensated).length
          return (
            <div className="space-y-2">
              <div className="grid grid-cols-4 gap-3 text-center">
                <div className="bg-red-50 rounded p-2">
                  <div className="text-xs text-gray-500">Orders Failed</div>
                  <div className="text-lg font-bold text-red-700">{allFailed}/{results.compensation.length}</div>
                </div>
                <div className="bg-orange-50 rounded p-2">
                  <div className="text-xs text-gray-500">Compensated</div>
                  <div className="text-lg font-bold text-orange-700">{allCompensated}</div>
                </div>
                <div className="bg-purple-50 rounded p-2">
                  <div className="text-xs text-gray-500">Avg Compensation</div>
                  <div className="text-lg font-bold text-purple-700">{avg(compDurations)}ms</div>
                </div>
                <div className="bg-gray-50 rounded p-2">
                  <div className="text-xs text-gray-500">Avg Total (fail+rollback)</div>
                  <div className="text-lg font-bold">{avg(totalDurations)}ms</div>
                </div>
              </div>
              <table className="w-full text-xs border">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-2 py-1 text-left border-b">#</th>
                    <th className="px-2 py-1 text-left border-b">Status</th>
                    <th className="px-2 py-1 text-right border-b">Total (ms)</th>
                    <th className="px-2 py-1 text-right border-b">Compensation (ms)</th>
                    <th className="px-2 py-1 text-left border-b">Step Transitions</th>
                    <th className="px-2 py-1 text-left border-b">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {results.compensation.map((r, i) => (
                    <tr key={i}>
                      <td className="px-2 py-1 border-b">{i + 1}</td>
                      <td className="px-2 py-1 border-b"><StatusBadge status={r.finalStatus} /></td>
                      <td className="px-2 py-1 border-b text-right">{r.totalSagaDurationMs}</td>
                      <td className="px-2 py-1 border-b text-right font-mono">{r.compensationDurationMs ?? '—'}</td>
                      <td className="px-2 py-1 border-b font-mono">
                        {Object.entries(r.stepTransitions).map(([k, v]) => `${k}:${v}`).join(' → ')}
                      </td>
                      <td className="px-2 py-1 border-b text-red-600 truncate max-w-[200px]">{r.failureReason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        })()}
      </section>
    </div>
  )
}
