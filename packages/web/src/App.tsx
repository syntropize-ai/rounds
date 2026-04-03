import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext.js';
import Layout from './components/Layout.js';
import Home from './pages/Home.js';
import Feed from './pages/Feed.js';
import Workspace from './pages/Workspace.js';
import Evidence from './pages/Evidence.js';
import ActionCenter from './pages/ActionCenter.js';
import PostMortem from './pages/PostMortem.js';
import SetupWizard from './pages/SetupWizard.js';
import Settings from './pages/Settings.js';
import Login from './pages/Login.js';
import Admin from './pages/Admin.js';
import Dashboards from './pages/Dashboards.js';
import DashboardWorkspace from './pages/DashboardWorkspace.js';
import Alerts from './pages/Alerts.js';
import AlertingPage from './pages/AlertingPage.js';
import Connections from './pages/Connections.js';
import { apiClient } from './api/client.js';

// Redirect to /setup on first visit if not yet configured
function SetupGuard({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (location.pathname === '/setup') {
      setChecked(true);
      return;
    }

    void apiClient.get<{ configured: boolean }>('/setup/status').then((res) => {
      if (!res.error && !res.data.configured) {
        navigate('/setup', { replace: true });
      } else {
        setChecked(true);
      }
    });
  }, [navigate, location.pathname]);

  if (!checked && location.pathname !== '/setup') return null;
  return <>{children}</>;
}

// Redirects unauthenticated users to /login. In dev mode, skips auth entirely.
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  // Dev mode: skip authentication
  if (import.meta.env.DEV) return <>{children}</>;
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <SetupGuard>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/login/callback" element={<Login />} />
            <Route path="/setup" element={<SetupWizard />} />
            <Route
              element={
                <ProtectedRoute>
                  <Layout />
                </ProtectedRoute>
              }
            >
              <Route path="/" element={<Home />} />
              <Route path="/feed" element={<Feed />} />
              <Route path="/investigate" element={<Workspace />} />
              <Route path="/investigate/:id" element={<Workspace />} />
              <Route path="/evidence/:id" element={<Evidence />} />
              <Route path="/actions" element={<ActionCenter />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/admin" element={<Admin />} />
              <Route path="/incidents/:id/post-mortem" element={<PostMortem />} />
              <Route path="/dashboards" element={<Dashboards />} />
              <Route path="/dashboards/:id" element={<DashboardWorkspace />} />
              <Route path="/alerts" element={<Alerts />} />
              <Route path="/alerting" element={<AlertingPage />} />
              <Route path="/connections" element={<Connections />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </SetupGuard>
      </AuthProvider>
    </BrowserRouter>
  );
}
