import { useRef, useCallback, useEffect, useState } from 'react'
import { useParams, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { SideNav } from '@/components/layout/SideNav'
import { TopBar } from '@/components/layout/TopBar'
import { AIPanel } from '@/components/layout/AIPanel'
import { DashboardGrid } from '@/components/dashboard/DashboardGrid'
import { useAIPanel } from '@/stores/aiPanel'
import { dashboardApi, Panel } from '@/api/dashboards'

const DEFAULT_SUGGESTIONS = [
  { label: 'Show error rates', icon: 'error' },
  { label: 'Add memory panel', icon: 'memory' },
  { label: 'Add alert rule', icon: 'notifications' },
]

export default function DashboardCanvas() {
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const { addMessage, appendToLastMessage, setStreaming, isOpen, clearMessages } = useAIPanel()
  const abortRef = useRef<AbortController | null>(null)
  const autoSentRef = useRef(false)

  // Local panels state — initialized from fetched dashboard, updated by SSE events
  const [panels, setPanels] = useState<Panel[]>([])
  const [dashTitle, setDashTitle] = useState('Dashboard')

  const { data: dashboard, isLoading } = useQuery({
    queryKey: ['dashboard', id],
    queryFn: () => dashboardApi.get(id!),
    enabled: !!id && id !== 'new',
  })

  // Sync from fetched dashboard (initial load)
  useEffect(() => {
    if (dashboard) {
      setPanels(dashboard.panels ?? [])
      setDashTitle(dashboard.title || 'Dashboard')
    }
  }, [dashboard])

  const handleDelete = useCallback(async () => {
    if (!id) return
    if (!window.confirm('确认删除这个 Dashboard？')) return
    try {
      await dashboardApi.delete(id)
    } catch (e: any) {
      if (!e?.message?.includes('404')) {
        alert('删除失败：' + (e?.message ?? '未知错误'))
        return
      }
    }
    navigate('/')
  }, [id, navigate])

  const handleSend = useCallback((message: string) => {
    abortRef.current?.abort()

    addMessage({ role: 'user', content: message })
    addMessage({ role: 'assistant', content: '', streaming: true })
    setStreaming(true)

    abortRef.current = dashboardApi.streamChat(
      id!,
      message,
      (chunk) => appendToLastMessage(chunk),
      () => setStreaming(false),
      () => setStreaming(false),
      // Panel mutation events — update local state immediately
      (event) => {
        if (event.type === 'panel_added' && event.panel) {
          setPanels((prev) => [...prev, event.panel!])
        } else if (event.type === 'panel_removed' && event.panelId) {
          setPanels((prev) => prev.filter((p) => p.id !== event.panelId))
        } else if (event.type === 'panel_modified' && event.panelId && event.patch) {
          setPanels((prev) => prev.map((p) => p.id === event.panelId ? { ...p, ...event.patch } : p))
        }
      },
      // Navigate event — e.g. after alert rule creation
      (path) => navigate(path),
    )
  }, [id, addMessage, appendToLastMessage, setStreaming])

  // Auto-send initial message when navigated from Home
  useEffect(() => {
    const initialMessage = (location.state as any)?.initialMessage
    if (initialMessage && id && !autoSentRef.current) {
      autoSentRef.current = true
      clearMessages()
      setTimeout(() => handleSend(initialMessage), 300)
    }
  }, [id, location.state, handleSend, clearMessages])

  return (
    <div className="flex h-screen bg-surface-base overflow-hidden">
      <SideNav />

      <div className="flex-1 flex flex-col overflow-hidden">
        <TopBar
          title={dashTitle}
          showTimeRange
          onDelete={id && id !== 'new' ? handleDelete : undefined}
        />

        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 bg-surface overflow-hidden flex flex-col">
            {isLoading ? (
              <div className="flex-1 flex items-center justify-center text-on-surface-variant">
                Loading dashboard...
              </div>
            ) : (
              <DashboardGrid panels={panels} />
            )}
          </div>

          {isOpen && (
            <AIPanel
              suggestions={DEFAULT_SUGGESTIONS}
              onSend={handleSend}
              placeholder="Ask to add or modify panels..."
            />
          )}
        </div>
      </div>
    </div>
  )
}
