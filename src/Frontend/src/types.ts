export interface Product {
  id: string
  name: string
  sku: string
  price: number
  stockQuantity: number
  reservedQuantity: number
  availableQuantity: number
}

export interface OrderSummary {
  id: string
  customerId: string
  status: string
  totalAmount: number
  failureReason: string | null
  createdAt: string
  completedAt: string | null
}

export interface SagaStep {
  name: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
}

export interface OrderStreamData {
  orderId: string
  status: string
  failureReason: string | null
  createdAt: string
  completedAt: string | null
  steps: SagaStep[]
}

export interface CartItem {
  productId: string
  productName: string
  quantity: number
  unitPrice: number
}

export interface RaceResult {
  index: number
  customerId: string
  httpStatus: number | null
  orderId: string | null
  orderStatus: string
  timeMs: number | null
}

export interface AppConfig {
  sagaMode: string
}
