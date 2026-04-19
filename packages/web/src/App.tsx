import React, { Suspense, lazy, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext.js';
import { ThemeProvider } from './contexts/ThemeContext.js';
import Layout from './components/Layout.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { apiClient } from './api/client.js';

const Home = lazy(() => import('./pages/Home.js'));
const Feed = lazy(() => import('./pages/Feed.js'));
const Investigations = lazy(() => import('./pages/Investigations.js'));
const InvestigationDetail = lazy(() => import('./pages/InvestigationDetail.js'));
const Evidence = lazy(() => import('./pages/Evidence.js'));
const ActionCenter = lazy(() => import('./pages/ActionCenter.js'));
const PostMortem = lazy(() => import('./pages/PostMortem.js'));
const SetupWizard = lazy(() => import('./pages/SetupWizard.js'));
const Settings = lazy(() => import('./pages/Settings.js'));
const Login = lazy(() => import('./pages/Login.js'));
const Admin = lazy(() => import('./pages/Admin.js'));
const Dashboards = lazy(() => import('./pages/Dashboards.js'));
const DashboardWorkspace = lazy(() => import('./pages/DashboardWorkspace.js'));
const Alerts = lazy(() => import('./pages/Alerts.js'));

function RouteFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-container">
      <span className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-outline border-t-primary" />
    </div>
  );
}

// Redirect to /setup when the instance has either no platform config OR
// no administrator yet. Both paths lead to the Setup Wizard — Wave 6
// added the "Create administrator" step so a first-run instance lands
// there regardless of which half is missing.
function SetupGuard({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    // /login stays open unconditionally — users sign in from there.
    if (location.pathname === '/login') {
      setChecked(true);
      return;
    }

    void apiClient
      .get<{ configured: boolean; hasAdmin: boolean }>('/setup/status')
      .then((res) => {
        if (res.error) {
          setChecked(true);
          return;
        }
        const ready = res.data.configured && res.data.hasAdmin;
        if (!ready && location.pathname !== '/setup') {
          // First-run: funnel every other page into the wizard.
          navigate('/setup', { replace: true });
        } else if (ready && location.pathname === '/setup') {
          // Already set up: don't let the wizard be reached by browser Back
          // (or a bookmarked /setup link) — push the user back into the app.
          navigate('/', { replace: true });
        } else {
          setChecked(true);
        }
      });
  }, [navigate, location.pathname]);

  if (!checked && location.pathname !== '/login') {
    return null;
  }
  return <>{children}</>;
}

// Redirects unauthenticated users to /login. Used to have a dev-mode
// bypass (`if (import.meta.env.DEV) return children`), but that hid the
// real login flow from every developer and masked auth-related bugs. If
// you want a frictionless dev session, complete the setup wizard once
// and your session cookie is persisted across `npm start` runs.
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <BrowserRouter>
          <AuthProvider>
            <Suspense fallback={<RouteFallback />}>
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
                  <Route path="/investigations" element={<Investigations />} />
                  <Route path="/investigations/:id" element={<InvestigationDetail />} />
                  <Route path="/investigate" element={<Navigate to="/investigations" replace />} />
                  <Route path="/investigate/:id" element={<Navigate to="/investigations" replace />} />
                  <Route path="/evidence/:id" element={<Evidence />} />
                  <Route path="/actions" element={<ActionCenter />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/admin/*" element={<Admin />} />
                  <Route path="/incidents/:id/post-mortem" element={<PostMortem />} />
                  <Route path="/dashboards" element={<Dashboards />} />
                  <Route path="/dashboards/:id" element={<DashboardWorkspace />} />
                  <Route path="/alerts" element={<Alerts />} />
                  <Route path="/connections" element={<Navigate to="/settings" replace />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
              </Routes>
              </SetupGuard>
            </Suspense>
          </AuthProvider>
        </BrowserRouter>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
