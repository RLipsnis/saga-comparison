import { useState, useEffect, useCallback } from 'react'

interface ToastMessage {
  id: number
  text: string
}

let nextId = 0

export function useToast() {
  const [messages, setMessages] = useState<ToastMessage[]>([])

  const addToast = useCallback((text: string) => {
    const id = nextId++
    setMessages((prev) => [...prev, { id, text }])
    setTimeout(() => {
      setMessages((prev) => prev.filter((m) => m.id !== id))
    }, 5000)
  }, [])

  return { messages, addToast }
}

export function ToastContainer({ messages }: { messages: ToastMessage[] }) {
  if (messages.length === 0) return null
  return (
    <div className="fixed top-4 right-4 z-50 space-y-2">
      {messages.map((m) => (
        <div key={m.id} className="bg-red-600 text-white px-4 py-2 rounded shadow text-sm max-w-sm">
          {m.text}
        </div>
      ))}
    </div>
  )
}
