/**
 * Login page — cookie-based auth with provider selector + local form.
 *
 * See docs/auth-perm-design/09-frontend.md §T8.1.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.js';
import { authApi, AuthApiError, type LoginProvider } from '../api/client.js';
import { RoundsLogo } from '../components/RoundsLogo.js';

/**
 * Map backend error status + message to the operator-facing copy specified
 * in the design doc. Exported for unit tests.
 */
export function formatLoginError(err: unknown): string {
  if (err instanceof AuthApiError) {
    if (err.status === 401) return 'Invalid email/username or password';
    if (err.status === 429) {
      // Try to extract "X minutes" from the server message (best-effort).
      const match = /(\d+)\s*minute/i.exec(err.message);
      const minutes = match ? match[1] : null;
      return minutes
        ? `Too many attempts. Try again in ${minutes} minutes.`
        : 'Too many attempts. Try again later.';
    }
    if (err.status >= 500) return 'Unable to log in right now. Please retry.';
    return err.message || 'Unable to log in right now. Please retry.';
  }
  return 'Unable to log in right now. Please retry.';
}

const SSO_FALLBACK_ICON = '↗';
const SSO_ICONS: Record<string, string> = {
  github: 'GH',
  google: 'G',
  generic: 'O',
  saml: 'S',
  ldap: 'L',
};

export default function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const auth = useAuth();

  const [providers, setProviders] = useState<LoginProvider[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [userField, setUserField] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const redirectTarget = useMemo(() => {
    const r = searchParams.get('redirect');
    // Prevent open-redirect: only allow internal paths.
    if (r && r.startsWith('/') && !r.startsWith('//')) return r;
    return '/';
  }, [searchParams]);

  // If already logged in, skip the form.
  useEffect(() => {
    if (auth.user) navigate(redirectTarget, { replace: true });
  }, [auth.user, navigate, redirectTarget]);

  // Surface an `?error=` redirect parameter (e.g. from failed OAuth callbacks).
  useEffect(() => {
    const err = searchParams.get('error');
    if (err) setError(decodeURIComponent(err.replace(/\+/g, ' ')));
  }, [searchParams]);

  useEffect(() => {
    let cancelled = false;
    void authApi
      .getLoginProviders()
      .then((list) => {
        if (!cancelled) {
          setProviders(list);
          setProvidersLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          // Fall back to local-only if the providers endpoint is unreachable.
          setProviders([{ id: 'local', name: 'Username / password', enabled: true }]);
          setProvidersLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const localProvider = providers.find((p) => p.id === 'local');
  const localEnabled = !providersLoaded || (localProvider?.enabled ?? true);
  const ssoProviders = providers.filter((p) => p.id !== 'local' && p.enabled);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await auth.login({ user: userField, password });
      navigate(redirectTarget, { replace: true });
    } catch (err) {
      setError(formatLoginError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-16 h-16 text-on-surface text-xl mb-4">
            <RoundsLogo className="w-9 h-9" />
          </div>
          <h1 className="text-2xl font-bold text-on-surface">OpenObs</h1>
          <p className="text-on-surface-variant mt-1">AI-native observability platform</p>
        </div>

        <div className="bg-surface-low border border-outline-variant rounded-2xl p-6">
          <h2 className="text-xl font-semibold text-on-surface mb-4 text-center">
            Sign in to your account
          </h2>

          {auth.logoutWarning && (
            <div
              role="status"
              className="mb-4 px-4 py-3 rounded-lg bg-chart-yellow/10 border border-chart-yellow/30 text-chart-yellow text-sm flex items-start justify-between gap-3"
            >
              <span>{auth.logoutWarning}</span>
              <button
                type="button"
                onClick={auth.dismissLogoutWarning}
                className="shrink-0 px-2 text-xs hover:underline"
                aria-label="Dismiss notice"
              >
                Dismiss
              </button>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="mb-4 px-4 py-3 rounded-lg bg-error/10 border border-error/30 text-error text-sm"
            >
              {error}
            </div>
          )}

          {ssoProviders.length > 0 && (
            <div className="space-y-3">
              {ssoProviders.map((p) => (
                <a
                  key={p.id}
                  href={p.url ?? `/api/login/${p.id}`}
                  className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl font-medium text-sm transition-all shadow-sm bg-surface-high hover:bg-outline-variant text-on-surface border border-outline-variant"
                >
                  <span className="text-base">
                    {SSO_ICONS[p.id] ?? SSO_FALLBACK_ICON}
                  </span>
                  Sign in with {p.name}
                </a>
              ))}
            </div>
          )}

          {ssoProviders.length > 0 && localEnabled && (
            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-outline-variant" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-surface-low px-3 text-on-surface-variant font-medium">
                  or continue with password
                </span>
              </div>
            </div>
          )}

          {localEnabled && (
            <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
              <div>
                <label htmlFor="login-user" className="block text-sm font-medium text-on-surface mb-1.5">
                  Email or username
                </label>
                <input
                  id="login-user"
                  name="user"
                  type="text"
                  value={userField}
                  onChange={(e) => setUserField(e.target.value)}
                  placeholder="you@company.com"
                  required
                  autoComplete="username"
                  className="w-full px-4 py-2.5 rounded-xl border border-outline-variant bg-surface-high text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                />
              </div>

              <div>
                <label htmlFor="login-password" className="block text-sm font-medium text-on-surface mb-1.5">
                  Password
                </label>
                <input
                  id="login-password"
                  name="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  autoComplete="current-password"
                  className="w-full px-4 py-2.5 rounded-xl border border-outline-variant bg-surface-high text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                />
              </div>

              <button
                type="submit"
                disabled={submitting || !userField || !password}
                className="w-full py-3 rounded-xl bg-primary text-on-primary-fixed font-semibold text-sm hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity shadow-md"
              >
                {submitting ? 'Signing in...' : 'Log in'}
              </button>

              <div className="text-center">
                <a
                  href="/forgot-password"
                  className="text-sm text-primary hover:underline"
                >
                  Forgot password?
                </a>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
