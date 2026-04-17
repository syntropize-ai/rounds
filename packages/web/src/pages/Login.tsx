import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.js';
import { api, apiClient } from '../api/client.js';
import { OpenObsLogo } from '../components/OpenObsLogo.js';

interface Provider {
  id: string;
  name: string;
  type: string;
}

interface LoginResult {
  user: import('../contexts/AuthContext.js').AuthUser;
  tokens: { accessToken: string; refreshToken: string; expiresIn: number };
}

const PROVIDER_ICONS: Record<string, string> = {
  github: 'GH',
  google: 'G',
  oidc: 'O',
  saml: 'S',
  local: '@',
};

const PROVIDER_COLORS: Record<string, string> = {
  github: 'bg-[var(--color-surface-high)] hover:bg-[var(--color-outline-variant)] text-[var(--color-on-surface)] border border-[var(--color-outline-variant)]',
  google: 'bg-[var(--color-surface-high)] hover:bg-[var(--color-outline-variant)] text-[var(--color-on-surface)] border border-[var(--color-outline-variant)]',
  oidc: 'bg-[var(--color-primary)] hover:opacity-90 text-[var(--color-on-primary-fixed)]',
  saml: 'bg-[var(--color-primary)] hover:opacity-90 text-[var(--color-on-primary-fixed)]',
};

export default function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { login, user } = useAuth();

  const [providers, setProviders] = useState<Provider[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Redirect if already logged in
  useEffect(() => {
    if (user) navigate('/', { replace: true });
  }, [user, navigate]);

  // Handle OAuth callback via one-time callback session exchange.
  useEffect(() => {
    const session = searchParams.get('session');
    if (session) {
      void (async () => {
        try {
          const { data, error } = await apiClient.get<LoginResult>(`/auth/callback-session/${encodeURIComponent(session)}`);
          if (!error && data) {
            login(data.tokens, data.user);
            navigate('/', { replace: true });
          } else {
            setError('Authentication failed. Please try again.');
          }
        } catch {
          setError('Authentication failed. Please try again.');
        }
      })();
    }
  }, [searchParams, login, navigate]);

  // Fetch available auth providers
  useEffect(() => {
    void api.get<{ providers: Provider[] }>('/auth/providers')
      .then((d) => setProviders(d.providers))
      .catch(() => setProviders([{ id: 'local', name: 'Email & Password', type: 'local' }]));
  }, []);

  // Show error from redirect (e.g. ?error=access_denied)
  useEffect(() => {
    const err = searchParams.get('error');
    if (err) setError(decodeURIComponent(err.replace(/\+/g, ' ')));
  }, [searchParams]);

  const handleLocalLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const data = await api.post<LoginResult>('/auth/login/local', { email, password });
      login(data.tokens, data.user);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error. Please check your connection.');
    } finally {
      setLoading(false);
    }
  };

  const ssoProviders = providers.filter((p) => p.type !== 'local');
  const hasLocal = providers.some((p) => p.type === 'local');

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary text-on-primary-fixed text-xl mb-4 shadow-lg">
            <OpenObsLogo className="w-9 h-9" />
          </div>
          <h1 className="text-2xl font-bold text-on-surface">OpenObs</h1>
          <p className="text-on-surface-variant mt-1">AI-native observability platform</p>
        </div>

        <div className="bg-surface-low border border-outline-variant rounded-2xl p-6">
          <h2 className="text-xl font-semibold text-on-surface mb-4 text-center">Sign in to your account</h2>

          {error && (
            <div className="mb-4 px-4 py-3 rounded-lg bg-error/10 border border-error/30 text-error text-sm">
              {error}
            </div>
          )}

          {ssoProviders.length > 0 && (
            <div className="space-y-3">
              {ssoProviders.map((p) => (
                <a
                  key={p.id}
                  href={`/api/auth/login/${p.id}`}
                  className={`w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl font-medium text-sm transition-all shadow-sm ${
                    PROVIDER_COLORS[p.type] ?? 'bg-surface-high text-on-surface hover:bg-outline-variant'
                  }`}
                >
                  <span className="text-base">
                    {PROVIDER_ICONS[p.id] ?? PROVIDER_ICONS[p.type] ?? '↗'}
                  </span>
                  Sign in with {p.name}
                </a>
              ))}
            </div>
          )}

          {ssoProviders.length > 0 && hasLocal && (
            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-outline-variant" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-surface-low px-3 text-on-surface-variant font-medium">or continue with email</span>
              </div>
            </div>
          )}

          {hasLocal && (
            <form onSubmit={(e) => void handleLocalLogin(e)} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-on-surface mb-1.5">Email address</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  required
                  autoComplete="email"
                  className="w-full px-4 py-2.5 rounded-xl border border-outline-variant bg-surface-high text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-on-surface mb-1.5">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  autoComplete="current-password"
                  className="w-full px-4 py-2.5 rounded-xl border border-outline-variant bg-surface-high text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                />
              </div>

              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm text-on-surface-variant cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="rounded border-outline-variant text-primary focus:ring-primary/30"
                  />
                  Remember me
                </label>
              </div>

              <button
                type="submit"
                disabled={loading || !email || !password}
                className="w-full py-3 rounded-xl bg-primary text-on-primary-fixed font-semibold text-sm hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity shadow-md"
              >
                {loading ? 'Signing in...' : 'Sign in'}
              </button>
            </form>
          )}

        </div>
      </div>
    </div>
  );
}
