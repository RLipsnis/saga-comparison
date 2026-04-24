import { AppConfig, OrderSummary, Product } from './types'

const BASE = ''

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, options)
  const body = await res.json()
  console.log(`[API] ${options?.method ?? 'GET'} ${url}`, res.status, body)
  if (!res.ok) throw new Error(body?.message ?? body?.reason ?? `HTTP ${res.status}`)
  return body as T
}

export const api = {
  getConfig: () => request<AppConfig>('/api/orders/config'),

  getProducts: () => request<Product[]>('/api/inventory/products'),

  restockProduct: (id: string, quantity: number) =>
    request<unknown>(`/api/inventory/products/${id}/restock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity }),
    }),

  resetInventory: () =>
    request<unknown>('/api/inventory/reset', { method: 'POST' }),

  createOrder: (customerId: string, items: { productId: string; quantity: number; unitPrice: number }[]) =>
    request<{ orderId: string; workflowId?: string; mode: string }>('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId, items }),
    }),

  getRecentOrders: (limit = 20) =>
    request<OrderSummary[]>(`/api/orders/recent?limit=${limit}`),

  getOrderStatus: (orderId: string) =>
    request<OrderSummary>(`/api/orders/${orderId}/status`),

  resetOrders: () =>
    request<unknown>('/api/orders/reset', { method: 'DELETE' }),

  getFailureRate: () =>
    request<{ failureRatePercent: number }>('/api/payments/failure-rate'),

  setFailureRate: (rate: number) =>
    request<{ failureRatePercent: number }>(`/api/payments/failure-rate/${rate}`, { method: 'POST' }),

  checkHealth: async (): Promise<boolean> => {
    try {
      await fetch('/api/orders/config')
      return true
    } catch {
      return false
    }
  },
}
