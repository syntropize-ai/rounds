import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { SideNav } from '@/components/layout/SideNav'
import { SuggestionChip } from '@/components/ui/SuggestionChip'
import { intentApi } from '@/api/intent'

const SUGGESTIONS = [
  { label: 'Analyze CPU spike in checkout-service', icon: 'speed', category: 'PERFORMANCE' },
  { label: 'Create a dashboard for user login latency', icon: 'grid_view', category: 'DASHBOARDS' },
  { label: 'Explain the recent 5xx error surge', icon: 'crisis_alert', category: 'INCIDENT' },
]

export default function Home() {
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const navigate = useNavigate()

  async function handleSubmit(text?: string) {
    const msg = (text || prompt).trim()
    if (!msg) return
    setLoading(true)
    setError('')
    try {
      const result = await intentApi.parse(msg)
      const path = result.navigate.replace(/^\/investigation\//, '/reports/')
      navigate(path, { state: { initialMessage: msg } })
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-screen bg-surface-base overflow-hidden">
      <SideNav />

      <main className="flex-1 flex flex-col items-center justify-center px-8">
        {/* Headline */}
        <div className="max-w-2xl w-full text-center mb-10">
          <h1 className="font-display font-extrabold text-5xl text-on-surface mb-4 leading-tight">
            Welcome, what are we{' '}
            <em className="not-italic gradient-text">investigating</em>{' '}
            today?
          </h1>
          <p className="text-on-surface-variant text-lg">
            Curator is analyzing your telemetry in real-time.
          </p>
        </div>

        {/* Main input */}
        <div className="max-w-2xl w-full mb-8">
          <div className="ai-input flex items-center gap-3 px-5 py-4">
            <span className="material-symbols-rounded text-primary text-2xl">search</span>
            <input
              autoFocus
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              placeholder="Ask about a service, create a dashboard, investigate an incident..."
              className="flex-1 bg-transparent text-on-surface placeholder:text-on-surface-variant outline-none text-base"
            />
            {loading ? (
              <span className="material-symbols-rounded text-primary text-xl animate-spin">progress_activity</span>
            ) : (
              <button
                onClick={() => handleSubmit()}
                className="gradient-primary rounded-lg p-1.5 text-black"
              >
                <span className="material-symbols-rounded text-base">arrow_forward</span>
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="max-w-2xl w-full mb-4 px-4 py-3 rounded-xl bg-error/10 border border-error/30 text-error text-sm flex items-start gap-2">
            <span className="material-symbols-rounded text-base mt-0.5 flex-shrink-0">error</span>
            <span>{error}</span>
          </div>
        )}

        {/* Suggestions */}
        <div className="max-w-2xl w-full grid grid-cols-3 gap-3">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              onClick={() => handleSubmit(s.label)}
              className="flex flex-col gap-2 p-4 rounded-2xl bg-surface-high hover:bg-surface-highest transition-all text-left group"
            >
              <div className="flex items-center gap-2">
                <span className="material-symbols-rounded text-primary text-base">{s.icon}</span>
                <span className="text-on-surface-variant text-xs font-medium tracking-widest uppercase">{s.category}</span>
              </div>
              <p className="text-on-surface text-sm group-hover:text-primary transition-all leading-snug">{s.label}</p>
            </button>
          ))}
        </div>
      </main>

      {/* Bottom-right status */}
      <div className="absolute bottom-6 right-6 flex items-center gap-2 text-secondary text-xs">
        <span className="w-2 h-2 rounded-full bg-secondary animate-pulse" />
        Collector Active
      </div>
    </div>
  )
}
