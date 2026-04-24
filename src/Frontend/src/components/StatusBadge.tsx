const colors: Record<string, string> = {
  Completed: 'bg-green-100 text-green-800',
  Failed: 'bg-red-100 text-red-800',
  Pending: 'bg-yellow-100 text-yellow-800',
  Compensating: 'bg-blue-100 text-blue-800',
  InventoryReserved: 'bg-yellow-100 text-yellow-800',
  PaymentProcessed: 'bg-yellow-100 text-yellow-800',
  ShippingArranged: 'bg-yellow-100 text-yellow-800',
}

export function StatusBadge({ status }: { status: string }) {
  const cls = colors[status] ?? 'bg-gray-100 text-gray-800'
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {status}
    </span>
  )
}
