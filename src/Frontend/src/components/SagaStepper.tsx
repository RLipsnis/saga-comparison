import { SagaStep } from '../types'

const icons: Record<string, string> = {
  pending: '○',
  in_progress: '◉',
  completed: '✓',
  failed: '✗',
}

const stepColors: Record<string, string> = {
  pending: 'text-gray-400',
  in_progress: 'text-blue-500 animate-pulse',
  completed: 'text-green-600',
  failed: 'text-red-600',
}

export function SagaStepper({ steps }: { steps: SagaStep[] }) {
  return (
    <div className="space-y-3">
      {steps.map((step, i) => (
        <div key={i} className="flex items-center gap-3">
          <span className={`text-xl font-bold w-6 text-center ${stepColors[step.status]}`}>
            {icons[step.status]}
          </span>
          <div className="flex-1">
            <span className={`text-sm font-medium ${step.status === 'pending' ? 'text-gray-400' : 'text-gray-800'}`}>
              {step.name}
            </span>
          </div>
          <span className={`text-xs ${stepColors[step.status]}`}>{step.status.replace('_', ' ')}</span>
        </div>
      ))}
    </div>
  )
}
