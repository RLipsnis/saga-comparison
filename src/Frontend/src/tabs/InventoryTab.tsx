import { useState } from 'react'
import { useProducts } from '../hooks/useProducts'
import { api } from '../api'

interface Props {
  onError: (msg: string) => void
}

export function InventoryTab({ onError }: Props) {
  const [autoRefresh, setAutoRefresh] = useState(true)
  const { products, loading, lastRefreshed, refresh } = useProducts(autoRefresh)
  const [restockId, setRestockId] = useState<string | null>(null)
  const [restockQty, setRestockQty] = useState(10)

  const doRestock = async () => {
    if (!restockId) return
    try {
      await api.restockProduct(restockId, restockQty)
      setRestockId(null)
      refresh()
    } catch (e: any) {
      onError(e.message)
    }
  }

  const resetAll = async () => {
    try {
      await api.resetInventory()
      refresh()
    } catch (e: any) {
      onError(e.message)
    }
  }

  const availColor = (qty: number) => {
    if (qty === 0) return 'text-red-600 font-bold'
    if (qty <= 5) return 'text-orange-500 font-medium'
    return 'text-green-600'
  }

  const secAgo = Math.round((Date.now() - lastRefreshed.getTime()) / 1000)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Inventory</h2>
        <div className="flex gap-3 items-center">
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            Auto-refresh
          </label>
          <button onClick={refresh} className="px-3 py-1 bg-gray-200 rounded text-sm hover:bg-gray-300">Refresh</button>
          <button onClick={resetAll} className="px-3 py-1 bg-red-100 text-red-700 rounded text-sm hover:bg-red-200">Reset All Stock</button>
        </div>
      </div>

      {loading && products.length === 0 && <div className="text-gray-400 text-sm">Loading...</div>}

      <table className="w-full text-sm border">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-3 py-2 text-left border-b">Product Name</th>
            <th className="px-3 py-2 text-left border-b">SKU</th>
            <th className="px-3 py-2 text-right border-b">Price</th>
            <th className="px-3 py-2 text-right border-b">In Stock</th>
            <th className="px-3 py-2 text-right border-b">Reserved</th>
            <th className="px-3 py-2 text-right border-b">Available</th>
            <th className="px-3 py-2 text-center border-b">Action</th>
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.id}>
              <td className="px-3 py-1.5 border-b">{p.name}</td>
              <td className="px-3 py-1.5 border-b font-mono text-xs">{p.sku}</td>
              <td className="px-3 py-1.5 border-b text-right">${p.price.toFixed(2)}</td>
              <td className="px-3 py-1.5 border-b text-right">{p.stockQuantity}</td>
              <td className="px-3 py-1.5 border-b text-right">{p.reservedQuantity}</td>
              <td className={`px-3 py-1.5 border-b text-right ${availColor(p.availableQuantity)}`}>{p.availableQuantity}</td>
              <td className="px-3 py-1.5 border-b text-center">
                {restockId === p.id ? (
                  <div className="flex items-center gap-1 justify-center">
                    <input type="number" min={1} value={restockQty} onChange={(e) => setRestockQty(Number(e.target.value))}
                      className="border rounded px-2 py-0.5 text-xs w-16" />
                    <button onClick={doRestock} className="text-green-600 text-xs hover:underline">OK</button>
                    <button onClick={() => setRestockId(null)} className="text-gray-400 text-xs hover:underline">Cancel</button>
                  </div>
                ) : (
                  <button onClick={() => setRestockId(p.id)} className="text-blue-600 text-xs hover:underline">Restock</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="text-xs text-gray-400">
        Last refreshed: {secAgo}s ago
        {autoRefresh && ' (auto-refreshing every 2s)'}
      </div>
    </div>
  )
}
