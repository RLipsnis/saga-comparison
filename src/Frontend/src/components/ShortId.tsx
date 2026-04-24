export function ShortId({ id }: { id: string }) {
  return (
    <span className="font-mono text-sm" title={id}>
      {id.substring(0, 8)}...
    </span>
  )
}
