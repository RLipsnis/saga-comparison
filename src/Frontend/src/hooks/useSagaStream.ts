import { useState, useEffect, useRef } from 'react'
import { OrderStreamData } from '../types'

export function useSagaStream(orderId: string | null) {
  const [data, setData] = useState<OrderStreamData | null>(null)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (!orderId) {
      setData(null)
      return
    }

    const es = new EventSource(`/api/orders/${orderId}/stream`)
    esRef.current = es

    es.onmessage = (event) => {
      try {
        const parsed: OrderStreamData = JSON.parse(event.data)
        console.log('[SSE]', parsed)
        setData(parsed)
        if (parsed.status === 'Completed' || parsed.status === 'Failed') {
          es.close()
        }
      } catch (e) {
        console.error('[SSE] parse error', e)
      }
    }

    es.onerror = () => {
      es.close()
    }

    return () => {
      es.close()
      esRef.current = null
    }
  }, [orderId])

  return data
}
