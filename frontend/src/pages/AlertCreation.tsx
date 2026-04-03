import { useState } from 'react'
import { SideNav } from '@/components/layout/SideNav'
import { TopBar } from '@/components/layout/TopBar'
import { AIPanel } from '@/components/layout/AIPanel'
import { Button } from '@/components/ui/Button'
import { useAIPanel } from '@/stores/aiPanel'
import { BarChart } from '@/components/charts/BarChart'

const SEVERITIES = [
  { key: 'P0', label: 'P0 Critical' },
  { key: 'P1', label: 'P1 High' },
  { key: 'P2', label: 'P2 Med' },
  { key: 'P3', label: 'P3 Low' },
]

const PREVIEW_DATA = Array.from({ length: 24 }, (_, i) => ({
  label: `${i}:00`,
  value: Math.random() * 8 + (i >= 14 && i <= 16 ? 12 : 1),
}))

export default function AlertCreation() {
  const [severity, setSeverity] = useState('P1')
  const [notifications, setNotifications] = useState({ slack: true, pagerduty: true, email: false })
  const { isOpen, addMessage } = useAIPanel()

  function toggleNotification(key: keyof typeof notifications) {
    setNotifications((n) => ({ ...n, [key]: !n[key] }))
  }

  return (
    <div className="flex h-screen bg-surface-base overflow-hidden">
      <SideNav />

      <div className="flex-1 flex flex-col overflow-hidden">
        <TopBar title="Create Alert" showTimeRange={false} />

        <div className="flex-1 flex overflow-hidden">
          {/* Left: Alert builder */}
          <div className="flex-1 bg-surface overflow-y-auto p-8">
            <div className="max-w-2xl mx-auto space-y-8">
              {/* Header */}
              <div>
                <h2 className="font-display font-bold text-xl">Create Alert: High Error Rate</h2>
                <p className="text-on-surface-variant text-sm mt-1">Define operational thresholds and notification logic</p>
              </div>

              {/* Condition */}
              <div className="bg-surface-high rounded-2xl p-5 space-y-3">
                <h3 className="text-sm font-medium text-on-surface-variant">Condition</h3>
                <div className="flex items-center gap-2 flex-wrap">
                  {['If', 'Error Rate', 'is greater than', '5%', 'for at least', '5m'].map((token, i) => (
                    <span
                      key={i}
                      className={`px-3 py-1.5 rounded-lg text-sm ${
                        i % 2 === 0
                          ? 'text-on-surface-variant'
                          : 'bg-surface-bright text-primary font-medium'
                      }`}
                    >
                      {token}
                    </span>
                  ))}
                </div>
              </div>

              {/* Severity */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-on-surface-variant">Severity</h3>
                <div className="flex gap-3">
                  {SEVERITIES.map((s) => (
                    <button
                      key={s.key}
                      onClick={() => setSeverity(s.key)}
                      className={`px-4 py-2 rounded-xl text-sm font-medium transition-all border ${
                        severity === s.key
                          ? 'bg-error/20 text-error border-error/60'
                          : 'bg-surface-high text-on-surface-variant border-transparent hover:bg-surface-highest'
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Preview chart */}
              <div className="bg-surface-high rounded-2xl p-5">
                <h3 className="text-sm text-on-surface-variant mb-3">Preview — Past 24h Error Rate</h3>
                <BarChart data={PREVIEW_DATA} height={160} color="#a3a6ff" unit="%" />
                <div className="mt-2 flex items-center gap-2">
                  <div className="flex-1 border-t border-dashed border-error/60" />
                  <span className="text-error text-xs font-medium">THRESHOLD 5%</span>
                </div>
              </div>

              {/* Notifications */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-on-surface-variant">Notification Channels</h3>
                <div className="space-y-2">
                  {[
                    { key: 'slack' as const, label: 'Slack', icon: 'chat' },
                    { key: 'pagerduty' as const, label: 'PagerDuty', icon: 'emergency' },
                    { key: 'email' as const, label: 'Email', icon: 'mail' },
                  ].map((ch) => (
                    <div
                      key={ch.key}
                      className="flex items-center justify-between bg-surface-high rounded-xl p-4"
                    >
                      <div className="flex items-center gap-3">
                        <span className="material-symbols-rounded text-on-surface-variant">{ch.icon}</span>
                        <span className="text-sm">{ch.label}</span>
                      </div>
                      <button
                        onClick={() => toggleNotification(ch.key)}
                        className={`w-10 h-6 rounded-full transition-all ${
                          notifications[ch.key] ? 'bg-primary' : 'bg-surface-highest'
                        }`}
                      >
                        <span
                          className={`block w-4 h-4 bg-white rounded-full shadow transition-transform mx-1 ${
                            notifications[ch.key] ? 'translate-x-4' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Save */}
              <Button size="lg" className="w-full justify-center">
                <span className="material-symbols-rounded text-base">save</span>
                Save Alert Rule
              </Button>
            </div>
          </div>

          {/* Right: AI Panel */}
          {isOpen && (
            <AIPanel
              suggestions={[
                { label: 'Adjust threshold', icon: 'tune' },
                { label: 'Add runbook link', icon: 'link' },
              ]}
              onSend={(msg) => addMessage({ role: 'user', content: msg })}
              placeholder="Refine alert or ask AI..."
            />
          )}
        </div>
      </div>
    </div>
  )
}
