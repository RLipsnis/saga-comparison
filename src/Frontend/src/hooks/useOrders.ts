import { useState, useCallback } from 'react'
import { api } from '../api'
import { OrderSummary } from '../types'

export function useOrders() {
  const [orders, setOrders] = useState<OrderSummary[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.getRecentOrders()
      setOrders(data)
    } catch (e) {
      console.error('Failed to fetch orders', e)
    } finally {
      setLoading(false)
    }
  }, [])

  return { orders, loading, refresh }
}
