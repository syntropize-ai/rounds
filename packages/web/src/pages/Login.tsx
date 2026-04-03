import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.js';

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
  github: 'bg-[#1C1C2E] hover:bg-[#2A2A3E] text-white border border-[#2A2A3E]',
  google: 'bg-[#1C1C2E] hover:bg-[#2A2A3E] text-[#E8E8ED] border border-[#2A2A3E]',
  oidc: 'bg-indigo-600 hover:bg-indigo-700 text-white',
  saml: 'bg-indigo-600 hover:bg-indigo-700 text-white',
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

  // Handle OAuth callback (token in URL params)
  useEffect(() => {
    const token = searchParams.get('token');
    const refresh = searchParams.get('refresh');
    if (token && refresh) {
      void (async () => {
        try {
          const res = await fetch('/api/auth/me', {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.ok) {
            const data = (await res.json()) as {
              user: import('../contexts/AuthContext.js').AuthUser;
            };
            login({
              accessToken: token,
              refreshToken: refresh,
              expiresIn: 900,
            }, data.user);
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
    fetch('/api/auth/providers')
      .then((r) => r.json())
      .then((d: { providers: Provider[] }) => setProviders(d.providers))
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
      const res = await fetch('/api/auth/login/local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        const data = (await res.json()) as LoginResult;
        login(data.tokens, data.user);
        navigate('/', { replace: true });
      } else {
        const err = (await res.json()) as { message?: string };
        setError(err.message ?? 'Login failed');
      }
    } catch {
      setError('Network error. Please check your connection.');
    } finally {
      setLoading(false);
    }
  };

  const ssoProviders = providers.filter((p) => p.type !== 'local');
  const hasLocal = providers.some((p) => p.type === 'local');

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#1a1a2e] via-[#16213e] to-[#0f3460] flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-600 text-white text-xl mb-4 shadow-lg">
            AI
          </div>
          <h1 className="text-2xl font-bold text-white">AgenticObs</h1>
          <p className="text-slate-300 mt-1">AI-native observability platform</p>
        </div>

        <div className="bg-[#141420] border border-[#2A2A3E] rounded-2xl p-6">
          <h2 className="text-xl font-semibold text-[#E8E8ED] mb-4 text-center">Sign in to your account</h2>

          {error && (
            <div className="mb-4 px-4 py-3 rounded-lg bg-red-900/20 border border-red-500/30 text-red-400 text-sm">
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
                    PROVIDER_COLORS[p.type] ?? 'bg-slate-200 text-slate-800 hover:bg-slate-100'
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
                <div className="w-full border-t border-[#2A2A3E]" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-[#141420] px-3 text-[#8888AA] font-medium">or continue with email</span>
              </div>
            </div>
          )}

          {hasLocal && (
            <form onSubmit={(e) => void handleLocalLogin(e)} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[#E8E8ED] mb-1.5">Email address</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  required
                  autoComplete="email"
                  className="w-full px-4 py-2.5 rounded-xl border border-[#2A2A3E] bg-[#1C1C2E] text-[#E8E8ED] placeholder:text-[#666680] focus:outline-none focus:ring-2 focus:ring-[#6366F1]/50 focus:border-[#6366F1]"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[#E8E8ED] mb-1.5">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  autoComplete="current-password"
                  className="w-full px-4 py-2.5 rounded-xl border border-[#2A2A3E] bg-[#1C1C2E] text-[#E8E8ED] placeholder:text-[#666680] focus:outline-none focus:ring-2 focus:ring-[#6366F1]/50 focus:border-[#6366F1]"
                />
              </div>

              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm text-[#8888AA] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="rounded border-[#2A2A3E] text-[#6366F1] focus:ring-[#6366F1]/30"
                  />
                  Remember me
                </label>
              </div>

              <button
                type="submit"
                disabled={loading || !email || !password}
                className="w-full py-3 rounded-xl bg-indigo-600 text-white font-semibold text-sm hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-md"
              >
                {loading ? 'Signing in...' : 'Sign in'}
              </button>
            </form>
          )}

          {process.env['NODE_ENV'] !== 'production' && (
            <p className="mt-6 text-center text-xs text-[#8888AA]">
              Dev: `admin@example.com` / `admin123`
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
