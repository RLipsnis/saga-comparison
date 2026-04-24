import { AppConfig } from '../types'

interface Props {
  config: AppConfig | null
  healthy: boolean
}

export function Navbar({ config, healthy }: Props) {
  const modeBadge = config?.sagaMode === 'choreography'
    ? 'bg-purple-100 text-purple-800'
    : 'bg-blue-100 text-blue-800'

  return (
    <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
      <span className="font-bold text-lg">Saga Comparison Dashboard</span>
      <div>
        {config ? (
          <span className={`px-3 py-1 rounded text-sm font-semibold uppercase ${modeBadge}`}>
            {config.sagaMode}
          </span>
        ) : (
          <span className="text-gray-400 text-sm">Loading config...</span>
        )}
      </div>
      <div className="flex items-center gap-2 text-sm">
        <span className={`inline-block w-2.5 h-2.5 rounded-full ${healthy ? 'bg-green-500' : 'bg-red-500'}`} />
        <span className="text-gray-500">{healthy ? 'Connected' : 'Disconnected'}</span>
      </div>
    </nav>
  )
}
