import { useState, useEffect } from 'react'
import { api } from '../api'
import { AppConfig } from '../types'

export function useConfig() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [healthy, setHealthy] = useState(true)

  useEffect(() => {
    api.getConfig().then(setConfig).catch(() => setConfig(null))

    const interval = setInterval(async () => {
      setHealthy(await api.checkHealth())
    }, 5000)

    return () => clearInterval(interval)
  }, [])

  return { config, healthy }
}
