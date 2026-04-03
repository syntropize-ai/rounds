import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { SideNav } from '@/components/layout/SideNav'
import { AIPanel } from '@/components/layout/AIPanel'
import { TopBar } from '@/components/layout/TopBar'
import { Badge } from '@/components/ui/Badge'
import { StatusDot } from '@/components/ui/StatusDot'
import { BarChart } from '@/components/charts/BarChart'
import { useAIPanel } from '@/stores/aiPanel'
import { investigationApi } from '@/api/investigations'

const MOCK_TIMELINE = [
  { id: '1', timestamp: '3:10 PM', label: 'Initial DB latency increase', severity: 'info' as const },
  { id: '2', timestamp: '3:15 PM', label: 'Alert Fired', severity: 'critical' as const },
  { id: '3', timestamp: '3:22 PM', label: 'Manual connection pool restart', severity: 'info' as const },
  { id: '4', timestamp: '3:25 PM', label: 'Incident mitigated', severity: 'resolved' as const },
]

const MOCK_RECOMMENDATIONS = [
  { id: '1', title: 'Scale Replica Count', icon: 'dynamic_feed', color: 'text-primary' },
  { id: '2', title: 'Optimize DB Pooling', icon: 'settings_input_component', color: 'text-secondary' },
  { id: '3', title: 'Circuit Breaker Update', icon: 'shield', color: 'text-tertiary' },
  { id: '4', title: 'Post-Mortem Review', icon: 'history_edu', color: 'text-on-surface-variant' },
]

const MOCK_SPIKE_DATA = Array.from({ length: 12 }, (_, i) => ({
  label: `${3 + Math.floor(i / 4)}:${String((i % 4) * 5).padStart(2, '0')} PM`,
  value: i === 6 ? 420 : Math.random() * 30 + 10,
}))

export default function InvestigationReport() {
  const { id } = useParams<{ id: string }>()
  const { isOpen, addMessage } = useAIPanel()

  const { data: report, isLoading } = useQuery({
    queryKey: ['investigation', id],
    queryFn: () => investigationApi.get(id!),
    enabled: !!id,
  })

  const severityColors: Record<string, string> = {
    info: 'bg-on-surface-variant',
    warning: 'bg-yellow-400',
    critical: 'bg-error',
    resolved: 'bg-secondary',
  }

  return (
    <div className="flex h-screen bg-surface-base overflow-hidden">
      <SideNav />

      <div className="flex-1 flex flex-col overflow-hidden">
        <TopBar title="Investigation Report" showTimeRange={false} />

        <div className="flex-1 flex overflow-hidden">
          {/* Left: Report document */}
          <div className="flex-1 bg-surface overflow-y-auto p-8">
            {isLoading ? (
              <div className="text-on-surface-variant">Loading report...</div>
            ) : (
              <div className="max-w-3xl mx-auto space-y-8">
                {/* Header */}
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <Badge variant="error">Critical Incident</Badge>
                    <span className="text-on-surface-variant text-sm">{id || 'INC-4092-A'}</span>
                  </div>
                  <h1 className="font-display font-bold text-2xl">
                    {report?.title || 'Investigation Report: Auth Service Spike (3:15 PM)'}
                  </h1>
                  <div className="flex items-center gap-4 text-on-surface-variant text-sm">
                    <span className="flex items-center gap-1">
                      <span className="material-symbols-rounded text-base">calendar_today</span>
                      {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="material-symbols-rounded text-base">person</span>
                      AI Curator & Engineering Team
                    </span>
                  </div>
                </div>

                {/* Summary */}
                <div className="flex gap-4 bg-surface-high rounded-2xl p-5">
                  <div className="w-1 bg-primary rounded-full flex-shrink-0" />
                  <p className="text-on-surface text-sm leading-relaxed">
                    {report?.summary || (
                      <>
                        The <span className="text-tertiary font-medium">auth-service</span> experienced a{' '}
                        <span className="text-error font-medium">450% increase</span> in p99 latency reaching{' '}
                        <span className="text-error font-medium">4.2s</span> (baseline 150ms) caused by connection
                        pool exhaustion following an upstream database failover at 3:10 PM.
                      </>
                    )}
                  </p>
                </div>

                {/* Key Findings */}
                <div>
                  <h2 className="font-display font-bold text-base mb-4">Key Findings</h2>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-surface-high rounded-2xl p-4">
                      <div className="text-on-surface-variant text-xs mb-1">Peak Latency</div>
                      <div className="text-error text-2xl font-display font-bold">4.2s</div>
                      <div className="text-on-surface-variant text-xs mt-1">vs 150ms avg</div>
                    </div>
                    <div className="bg-surface-high rounded-2xl p-4">
                      <div className="text-on-surface-variant text-xs mb-1">Error Rate</div>
                      <div className="text-secondary text-2xl font-display font-bold">12.4%</div>
                      <div className="text-on-surface-variant text-xs mt-1">HTTP 503</div>
                    </div>
                  </div>
                </div>

                {/* Timeline */}
                <div>
                  <h2 className="font-display font-bold text-base mb-4">Timeline</h2>
                  <div className="relative pl-4">
                    <div className="absolute left-4 top-2 bottom-2 w-px bg-outline/30" />
                    <div className="space-y-4">
                      {MOCK_TIMELINE.map((event, i) => (
                        <div key={event.id} className="flex items-start gap-4 relative">
                          <div className={`w-3 h-3 rounded-full mt-0.5 flex-shrink-0 relative z-10 ${severityColors[event.severity]}`} />
                          <div>
                            <span className="text-on-surface-variant text-xs">{event.timestamp}</span>
                            <p className={`text-sm mt-0.5 ${event.severity === 'critical' ? 'text-error font-semibold' : 'text-on-surface'}`}>
                              {event.label}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Latency spike chart */}
                <div className="bg-surface-high rounded-2xl p-4">
                  <h3 className="text-sm text-on-surface-variant mb-3">Latency Spike (ms)</h3>
                  <BarChart
                    data={MOCK_SPIKE_DATA}
                    height={160}
                    color="#ff6e84"
                    unit="ms"
                  />
                </div>

                {/* Recommendations */}
                <div>
                  <h2 className="font-display font-bold text-base mb-4">Recommendations</h2>
                  <div className="grid grid-cols-2 gap-3">
                    {MOCK_RECOMMENDATIONS.map((rec) => (
                      <button
                        key={rec.id}
                        className="flex items-center gap-3 bg-surface-high rounded-2xl p-4 text-left hover:bg-surface-highest transition-all"
                      >
                        <span className={`material-symbols-rounded text-xl ${rec.color}`}>{rec.icon}</span>
                        <span className="text-sm text-on-surface">{rec.title}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Right: AI Panel */}
          {isOpen && (
            <AIPanel
              suggestions={[
                { label: 'How to fix?', icon: 'build' },
                { label: 'Show DB logs', icon: 'article' },
                { label: 'Compare to last week', icon: 'compare' },
              ]}
              onSend={(msg) => addMessage({ role: 'user', content: msg })}
            />
          )}
        </div>
      </div>
    </div>
  )
}
