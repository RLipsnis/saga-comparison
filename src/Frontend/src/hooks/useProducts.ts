import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../api'
import { Product } from '../types'

export function useProducts(autoRefresh = true) {
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date())
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    try {
      const data = await api.getProducts()
      setProducts(data)
      setLastRefreshed(new Date())
    } catch (e) {
      console.error('Failed to fetch products', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(refresh, 2000)
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [autoRefresh, refresh])

  return { products, loading, lastRefreshed, refresh }
}
