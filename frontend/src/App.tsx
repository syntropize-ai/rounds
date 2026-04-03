import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { setupApi } from '@/api/setup'
import Home from '@/pages/Home'
import DashboardCanvas from '@/pages/DashboardCanvas'
import InvestigationReport from '@/pages/InvestigationReport'
import AlertCreation from '@/pages/AlertCreation'
import Explorer from '@/pages/Explorer'
import ExplorerFolder from '@/pages/ExplorerFolder'
import Setup from '@/pages/Setup'
import Settings from '@/pages/Settings'

// Guards all routes: redirects to /setup if not configured
function SetupGuard({ children }: { children: React.ReactNode }) {
  const [checking, setChecking] = useState(true)
  const [configured, setConfigured] = useState(true)
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    if (location.pathname === '/setup') {
      setChecking(false)
      return
    }
    setupApi
      .getStatus()
      .then((status) => {
        if (!status.configured) {
          navigate('/setup', { replace: true })
        } else {
          setConfigured(true)
        }
      })
      .catch(() => {
        // Backend not reachable — let user through, show errors in-context
        setConfigured(true)
      })
      .finally(() => setChecking(false))
  }, [])

  if (checking) {
    return (
      <div className="min-h-screen bg-surface-base flex items-center justify-center">
        <div className="flex items-center gap-3 text-on-surface-variant text-sm">
          <span className="material-symbols-rounded animate-spin text-primary">progress_activity</span>
          Starting Curator...
        </div>
      </div>
    )
  }

  return <>{children}</>
}

export default function App() {
  return (
    <SetupGuard>
      <Routes>
        <Route path="/setup" element={<Setup />} />
        <Route path="/" element={<Home />} />
        <Route path="/dashboards/:id" element={<DashboardCanvas />} />
        <Route path="/reports/:id" element={<InvestigationReport />} />
        <Route path="/alerts/new" element={<AlertCreation />} />
        <Route path="/explorer" element={<Explorer />} />
        <Route path="/explorer/folder/:id" element={<ExplorerFolder />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </SetupGuard>
  )
}
