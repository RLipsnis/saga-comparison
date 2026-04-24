import { useEffect, useState } from 'react'
import { useOrders } from '../hooks/useOrders'
import { ShortId } from '../components/ShortId'
import { StatusBadge } from '../components/StatusBadge'
import { api } from '../api'

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour12: false })
}

interface Props {
  onError: (msg: string) => void
}

export function OrderHistoryTab({ onError }: Props) {
  const { orders, loading, refresh } = useOrders()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => { refresh() }, [refresh])

  const clearAll = async () => {
    if (!confirm('Delete all orders?')) return
    try {
      await api.resetOrders()
      refresh()
    } catch (e: any) {
      onError(e.message)
    }
  }

  const duration = (created: string, completed: string | null) => {
    if (!completed) return 'in progress'
    const ms = new Date(completed).getTime() - new Date(created).getTime()
    return `${ms}ms`
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Order History</h2>
        <div className="flex gap-2">
          <button onClick={refresh} className="px-3 py-1 bg-gray-200 rounded text-sm hover:bg-gray-300">
            Refresh
          </button>
          <button onClick={clearAll} className="px-3 py-1 bg-red-100 text-red-700 rounded text-sm hover:bg-red-200">
            Clear All Orders
          </button>
        </div>
      </div>

      {loading && <div className="text-gray-400 text-sm">Loading...</div>}

      <table className="w-full text-sm border">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-3 py-2 text-left border-b">Order ID</th>
            <th className="px-3 py-2 text-left border-b">Customer</th>
            <th className="px-3 py-2 text-left border-b">Total</th>
            <th className="px-3 py-2 text-left border-b">Status</th>
            <th className="px-3 py-2 text-left border-b">Created</th>
            <th className="px-3 py-2 text-left border-b">Duration</th>
            <th className="px-3 py-2 text-left border-b">Failure Reason</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id} className="cursor-pointer hover:bg-gray-50"
              onClick={() => setExpandedId(expandedId === o.id ? null : o.id)}>
              <td className="px-3 py-1.5 border-b"><ShortId id={o.id} /></td>
              <td className="px-3 py-1.5 border-b font-mono text-xs">{o.customerId?.substring(0, 8) ?? '—'}...</td>
              <td className="px-3 py-1.5 border-b">${o.totalAmount.toFixed(2)}</td>
              <td className="px-3 py-1.5 border-b"><StatusBadge status={o.status} /></td>
              <td className="px-3 py-1.5 border-b text-xs">{fmtTime(o.createdAt)}</td>
              <td className="px-3 py-1.5 border-b text-xs">{duration(o.createdAt, o.completedAt)}</td>
              <td className="px-3 py-1.5 border-b text-xs text-red-600">{o.failureReason ?? ''}</td>
            </tr>
          ))}
          {orders.length === 0 && !loading && (
            <tr><td colSpan={7} className="px-3 py-4 text-center text-gray-400">No orders yet</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
