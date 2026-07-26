import React, { Suspense, lazy, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext.js';
import { ThemeProvider } from './contexts/ThemeContext.js';
import Layout from './components/Layout.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { apiClient } from './api/client.js';
import { setUnauthorizedHandler } from './api/transport.js';
import { useRouteTitle } from './hooks/useRouteTitle.js';

// Single auth-boundary handler for transport-layer 401s. Registered at
// module load (before AuthProvider mounts) so even early requests funnel
// through here. Idempotent: a burst of concurrent 401s redirects exactly
// once. We deliberately leave `/login` and `/login/callback` alone so the
// login page doesn't bounce in a loop when /api/user returns 401.
let redirectingToLogin = false;
setUnauthorizedHandler(() => {
  if (redirectingToLogin) return;
  if (typeof window === 'undefined') return;
  const path = window.location.pathname;
  if (path === '/login' || path === '/login/callback') return;
  redirectingToLogin = true;
  try {
    localStorage.removeItem('agentic_obs_auth');
    localStorage.removeItem('api_key');
  } catch {
    // localStorage can throw in privacy-mode iframes; the redirect still helps.
  }
  window.location.href = '/login';
});

const Home = lazy(() => import('./pages/Home.js'));
const Feed = lazy(() => import('./pages/Feed.js'));
const Investigations = lazy(() => import('./pages/Investigations.js'));
const InvestigationDetail = lazy(() => import('./pages/InvestigationDetail.js'));
const Evidence = lazy(() => import('./pages/Evidence.js'));
const ActionCenter = lazy(() => import('./pages/ActionCenter.js'));
const PlanDetail = lazy(() => import('./pages/PlanDetail.js'));
const SetupWizard = lazy(() => import('./pages/SetupWizard.js'));
const Settings = lazy(() => import('./pages/Settings.js'));
const Login = lazy(() => import('./pages/Login.js'));
const Admin = lazy(() => import('./pages/Admin.js'));
const Dashboards = lazy(() => import('./pages/Dashboards.js'));
const DashboardWorkspace = lazy(() => import('./pages/DashboardWorkspace.js'));
const Alerts = lazy(() => import('./pages/Alerts.js'));
const AlertRuleEdit = lazy(() => import('./pages/AlertRuleEdit.js'));

// Titles every route from one place, rather than making each of the ~20 page
// components remember to set its own. Renders nothing.
function RouteTitle() {
  useRouteTitle();
  return null;
}

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
  const [unreachable, setUnreachable] = useState<string | null>(null);

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
          // "The API did not answer" is not "setup is finished". Falling
          // through here sent a first-run user with a backend that failed to
          // start to the login page, where they typed credentials into a form
          // that could never succeed and nothing said why. Only unreachable
          // and server-side failures block — a 4xx is answered, and the app
          // should carry on and let the auth gate decide.
          const err = res.error as { code: string; status?: number; message: string };
          if (isUnreachable(err)) {
            setUnreachable(unreachableDetail(err));
            return;
          }
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

  if (unreachable) {
    return <ApiUnreachableScreen detail={unreachable} />;
  }
  if (!checked && location.pathname !== '/login') {
    return null;
  }
  return <>{children}</>;
}

/**
 * Which failures mean "we learned nothing" rather than "the answer was no".
 *
 * Checking only the transport's own codes was not enough, and running it is
 * what showed that: almost nobody talks to the API directly. In development
 * Vite proxies `/api`, in Kubernetes an ingress does, and a proxy in front of
 * a dead backend answers **502** rather than dropping the connection. So the
 * browser sees a normal HTTP response and the "nothing answered" branch never
 * fires — which is the deployment shape nearly every self-hosted user has.
 *
 * 500 is deliberately not here. That is the application itself throwing, which
 * means it is running, and telling someone their API is unreachable would send
 * them to check the wrong thing.
 */
export function isUnreachable(error: { code: string; status?: number }): boolean {
  if (error.code === 'NETWORK_ERROR' || error.code === 'REQUEST_TIMEOUT') return true;
  return error.status === 502 || error.status === 503 || error.status === 504;
}

/**
 * What to say. A proxy's "Bad Gateway" is not an explanation, so the gateway
 * statuses get wording of their own rather than the passed-through statusText.
 */
export function unreachableDetail(error: { code: string; status?: number; message: string }): string {
  if (error.status === 502 || error.status === 503 || error.status === 504) {
    return 'The web server is running but the Rounds API behind it did not respond. Check that the API process is up.';
  }
  return error.message;
}

/**
 * Shown instead of guessing.
 *
 * The single most likely reason a self-hosted install shows nothing is that
 * the API process is not running — so it says that first, and repeats the
 * transport layer's own advice rather than inventing new wording.
 */
export function ApiUnreachableScreen({ detail }: { detail: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-[var(--color-surface)]">
      <div className="max-w-md space-y-3 text-center">
        <h1 className="text-xl font-bold text-[var(--color-on-surface)]">
          Rounds can&apos;t reach its API
        </h1>
        <p className="text-sm text-[var(--color-on-surface-variant)] leading-relaxed">
          {detail}
        </p>
        <p className="text-sm text-[var(--color-on-surface-variant)] leading-relaxed">
          This page is not a sign-in problem — until the API answers, signing in cannot work.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-[var(--color-on-primary-fixed)] text-sm font-semibold"
        >
          Try again
        </button>
      </div>
    </div>
  );
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

/**
 * Gate a subtree on a permission predicate. Used for pages whose entire
 * surface is write-only — hiding the nav entry alone is not enough since
 * a URL-typer or a bookmarked link would still render the page shell. We
 * redirect to Home rather than showing an empty page so the user isn't
 * stuck on a broken chrome they can't use.
 */
function PermissionGate({
  children,
  allow,
}: {
  children: React.ReactNode;
  allow: () => boolean;
}) {
  const { loading } = useAuth();
  if (loading) return null;
  if (!allow()) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function SettingsGate({ children }: { children: React.ReactNode }) {
  const { user, hasPermission } = useAuth();
  return (
    <PermissionGate
      allow={() =>
        !!user
        && (user.isServerAdmin
          || hasPermission('connectors:write')
          || hasPermission('connectors:create')
          || hasPermission('admin:write'))
      }
    >
      {children}
    </PermissionGate>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <BrowserRouter>
          <RouteTitle />
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
                  <Route path="/plans/:id" element={<PlanDetail />} />
                  <Route
                    path="/settings"
                    element={
                      <SettingsGate>
                        <Settings />
                      </SettingsGate>
                    }
                  />
                  <Route path="/admin/*" element={<Admin />} />
                  <Route path="/dashboards" element={<Dashboards />} />
                  <Route path="/dashboards/:id" element={<DashboardWorkspace />} />
                  <Route path="/alerts" element={<Alerts />} />
                  <Route path="/alerts/:id/edit" element={<AlertRuleEdit />} />
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
