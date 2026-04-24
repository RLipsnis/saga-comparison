import { useState, useEffect } from 'react'
import { api } from '../api'
import { Product, RaceResult } from '../types'
import { ShortId } from '../components/ShortId'

interface Props {
  onError: (msg: string) => void
}

export function RaceConditionTab({ onError }: Props) {
  const [products, setProducts] = useState<Product[]>([])
  const [selectedProduct, setSelectedProduct] = useState('')
  const [concurrency, setConcurrency] = useState(5)
  const [qtyPerOrder, setQtyPerOrder] = useState(1)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<RaceResult[]>([])

  const loadProducts = () => {
    api.getProducts()
      .then((p) => setProducts(p.filter((x) => x.availableQuantity <= 5 && x.availableQuantity > 0)))
      .catch((e) => onError(e.message))
  }

  useEffect(() => { loadProducts() }, [])

  const launchRace = async () => {
    if (!selectedProduct) return
    const prod = products.find((p) => p.id === selectedProduct)
    if (!prod) return

    setRunning(true)
    const initial: RaceResult[] = Array.from({ length: concurrency }, (_, i) => ({
      index: i + 1,
      customerId: crypto.randomUUID(),
      httpStatus: null,
      orderId: null,
      orderStatus: 'Pending...',
      timeMs: null,
    }))
    setResults(initial)

    const promises = initial.map(async (r) => {
      const start = performance.now()
      try {
        const res = await api.createOrder(r.customerId, [
          { productId: prod.id, quantity: qtyPerOrder, unitPrice: prod.price },
        ])
        const elapsed = Math.round(performance.now() - start)
        return { ...r, httpStatus: 202, orderId: res.orderId, orderStatus: 'Accepted', timeMs: elapsed }
      } catch (e: any) {
        const elapsed = Math.round(performance.now() - start)
        return { ...r, httpStatus: 500, orderStatus: `Error: ${e.message}`, timeMs: elapsed }
      }
    })

    const settled = await Promise.all(promises)
    setResults(settled)

    // Wait a moment then check actual order statuses
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const updated = await Promise.all(
      settled.map(async (r) => {
        if (!r.orderId) return r
        try {
          const status = await api.getOrderStatus(r.orderId)
          return { ...r, orderStatus: status.status }
        } catch {
          return r
        }
      })
    )
    setResults(updated)
    setRunning(false)
    loadProducts()
  }

  const resetAll = async () => {
    try {
      await api.resetInventory()
      await api.resetOrders()
      setResults([])
      loadProducts()
    } catch (e: any) {
      onError(e.message)
    }
  }

  const succeeded = results.filter((r) => r.orderStatus === 'Completed').length
  const failed = results.filter((r) => r.orderStatus === 'Failed' || r.orderStatus.startsWith('Error')).length
  const pending = results.filter((r) => !['Completed', 'Failed'].includes(r.orderStatus) && !r.orderStatus.startsWith('Error')).length

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Race Condition Test</h2>
      <p className="text-sm text-gray-500">Fire multiple concurrent orders for a low-stock product to test optimistic concurrency.</p>

      <div className="flex gap-4 items-end flex-wrap">
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1">Product (low stock only)</label>
          <select className="border rounded px-3 py-1.5 text-sm" value={selectedProduct}
            onChange={(e) => setSelectedProduct(e.target.value)}>
            <option value="">Select...</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.name} (Available: {p.availableQuantity})</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1">Concurrent orders</label>
          <input type="range" min={2} max={20} value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))} className="w-32" />
          <span className="ml-2 text-sm font-mono">{concurrency}</span>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1">Qty/order</label>
          <input type="number" min={1} max={10} value={qtyPerOrder}
            onChange={(e) => setQtyPerOrder(Number(e.target.value))} className="border rounded px-3 py-1.5 text-sm w-16" />
        </div>
        <button onClick={launchRace} disabled={running || !selectedProduct}
          className="px-4 py-1.5 bg-amber-500 text-white rounded font-medium hover:bg-amber-600 disabled:opacity-50">
          {running ? 'Racing...' : 'Launch Race!'}
        </button>
        <button onClick={resetAll} className="px-4 py-1.5 bg-gray-200 rounded text-sm hover:bg-gray-300">
          Reset &amp; Try Again
        </button>
      </div>

      {results.length > 0 && (
        <>
          <table className="w-full text-sm border">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left border-b">#</th>
                <th className="px-3 py-2 text-left border-b">Customer ID</th>
                <th className="px-3 py-2 text-left border-b">HTTP</th>
                <th className="px-3 py-2 text-left border-b">Order Status</th>
                <th className="px-3 py-2 text-left border-b">Time (ms)</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => {
                const rowColor = r.orderStatus === 'Completed' ? 'bg-green-50' :
                  (r.orderStatus === 'Failed' || r.orderStatus.startsWith('Error')) ? 'bg-red-50' : ''
                return (
                  <tr key={r.index} className={rowColor}>
                    <td className="px-3 py-1.5 border-b">{r.index}</td>
                    <td className="px-3 py-1.5 border-b font-mono">{r.customerId.substring(0, 8)}...</td>
                    <td className="px-3 py-1.5 border-b">{r.httpStatus ?? '...'}</td>
                    <td className="px-3 py-1.5 border-b">{r.orderStatus}</td>
                    <td className="px-3 py-1.5 border-b">{r.timeMs ?? '...'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {!running && (
            <div className="flex gap-4 text-sm">
              <span className="text-green-700 font-medium">{succeeded} succeeded</span>
              <span className="text-red-700 font-medium">{failed} failed</span>
              {pending > 0 && <span className="text-yellow-700 font-medium">{pending} pending</span>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
