import { useState, useEffect } from 'react'
import { api } from '../api'
import { CartItem, Product } from '../types'
import { useSagaStream } from '../hooks/useSagaStream'
import { SagaStepper } from '../components/SagaStepper'
import { ShortId } from '../components/ShortId'
import { StatusBadge } from '../components/StatusBadge'

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour12: false, fractionalSecondDigits: 3 })
}

interface Props {
  onError: (msg: string) => void
}

export function PlaceOrderTab({ onError }: Props) {
  const [products, setProducts] = useState<Product[]>([])
  const [customerId, setCustomerId] = useState(crypto.randomUUID())
  const [address] = useState('123 Test Street')
  const [selectedProduct, setSelectedProduct] = useState('')
  const [quantity, setQuantity] = useState(1)
  const [cart, setCart] = useState<CartItem[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [trackingOrderId, setTrackingOrderId] = useState<string | null>(null)

  const streamData = useSagaStream(trackingOrderId)

  useEffect(() => {
    api.getProducts().then(setProducts).catch((e) => onError(e.message))
  }, [onError])

  const addToCart = () => {
    const prod = products.find((p) => p.id === selectedProduct)
    if (!prod) return
    setCart((prev) => [...prev, { productId: prod.id, productName: prod.name, quantity, unitPrice: prod.price }])
    setQuantity(1)
  }

  const removeFromCart = (index: number) => {
    setCart((prev) => prev.filter((_, i) => i !== index))
  }

  const total = cart.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)

  const placeOrder = async () => {
    if (cart.length === 0) return
    setSubmitting(true)
    try {
      const items = cart.map((c) => ({ productId: c.productId, quantity: c.quantity, unitPrice: c.unitPrice }))
      const res = await api.createOrder(customerId, items)
      setTrackingOrderId(res.orderId)
    } catch (e: any) {
      onError(e.message)
      setSubmitting(false)
    }
  }

  const reset = () => {
    setCart([])
    setSubmitting(false)
    setTrackingOrderId(null)
    setCustomerId(crypto.randomUUID())
  }

  const isTerminal = streamData?.status === 'Completed' || streamData?.status === 'Failed'
  const duration = streamData?.createdAt && streamData?.completedAt
    ? (new Date(streamData.completedAt).getTime() - new Date(streamData.createdAt).getTime())
    : null

  return (
    <div className="grid grid-cols-2 gap-6">
      {/* LEFT: Order Form */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Order Form</h2>

        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1">Customer ID</label>
          <input className="w-full border rounded px-3 py-1.5 text-sm font-mono" value={customerId}
            onChange={(e) => setCustomerId(e.target.value)} />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1">Shipping Address</label>
          <input className="w-full border rounded px-3 py-1.5 text-sm" value={address} readOnly />
        </div>

        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-600 mb-1">Product</label>
            <select className="w-full border rounded px-3 py-1.5 text-sm" value={selectedProduct}
              onChange={(e) => setSelectedProduct(e.target.value)}>
              <option value="">Select a product...</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.name} (Available: {p.availableQuantity})</option>
              ))}
            </select>
          </div>
          <div className="w-20">
            <label className="block text-sm font-medium text-gray-600 mb-1">Qty</label>
            <input type="number" min={1} className="w-full border rounded px-3 py-1.5 text-sm" value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))} />
          </div>
          <button onClick={addToCart} disabled={!selectedProduct}
            className="px-3 py-1.5 bg-gray-200 rounded text-sm hover:bg-gray-300 disabled:opacity-50">
            Add Item
          </button>
        </div>

        {cart.length > 0 && (
          <div className="border rounded p-3 space-y-2">
            <div className="text-sm font-medium text-gray-600">Cart</div>
            {cart.map((item, i) => (
              <div key={i} className="flex justify-between items-center text-sm">
                <span>{item.productName} × {item.quantity}</span>
                <div className="flex items-center gap-2">
                  <span>${(item.quantity * item.unitPrice).toFixed(2)}</span>
                  <button onClick={() => removeFromCart(i)} className="text-red-500 text-xs hover:underline">Remove</button>
                </div>
              </div>
            ))}
            <div className="border-t pt-2 font-semibold text-sm flex justify-between">
              <span>Total</span>
              <span>${total.toFixed(2)}</span>
            </div>
          </div>
        )}

        <button onClick={placeOrder} disabled={submitting || cart.length === 0}
          className="w-full py-2 bg-green-600 text-white rounded font-medium hover:bg-green-700 disabled:opacity-50">
          {submitting ? 'Processing...' : 'Place Order'}
        </button>
      </div>

      {/* RIGHT: Live Tracker */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Live Order Tracker</h2>

        {!trackingOrderId && (
          <div className="text-gray-400 text-sm">Place an order to see live tracking...</div>
        )}

        {trackingOrderId && (
          <div className="border rounded p-4 space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-500">Order:</span>
              <ShortId id={trackingOrderId} />
            </div>

            {streamData?.steps && <SagaStepper steps={streamData.steps} />}

            {streamData && (
              <div className="pt-3 border-t space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">Status:</span>
                  <StatusBadge status={streamData.status} />
                </div>
                {streamData.failureReason && (
                  <div className="text-sm text-red-600">Reason: {streamData.failureReason}</div>
                )}
                {streamData.createdAt && (
                  <div className="text-xs text-gray-400">Started: {fmtTime(streamData.createdAt)}</div>
                )}
                {duration !== null && (
                  <div className="text-xs text-gray-400">Duration: {duration}ms</div>
                )}
              </div>
            )}

            {isTerminal && (
              <button onClick={reset} className="w-full py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">
                Place Another Order
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
