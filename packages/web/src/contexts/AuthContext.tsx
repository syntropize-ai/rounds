import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';

// Types

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  role: 'admin' | 'operator' | 'investigator' | 'viewer' | 'readonly';
  authProvider: string;
  teams: string[];
  lastLoginAt: string;
}

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds
}

interface AuthContextValue {
  user: AuthUser | null;
  tokens: AuthTokens | null;
  loading: boolean;
  login: (tokens: AuthTokens, user: AuthUser) => void;
  logout: () => Promise<void>;
  hasPermission: (permission: string) => boolean;
  isAdmin: boolean;
}

// Permission helpers mirrors backend RBAC

const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: ['*'],
  operator: ['investigations:*', 'execution:read', 'execution:execute', 'execution:approve', 'incidents:*', 'feeds:*', 'metadata:*'],
  investigator: ['investigation:*', 'evidence:read', 'execution:read', 'incident:read', 'metadata:read'],
  viewer: ['investigations:read', 'evidence:read', 'feeds:read', 'incident:read'],
  readonly: ['investigations:read', 'feeds:read'],
};

function checkPermission(userPerms: string[], required: string): boolean {
  const [reqRes, reqAct] = required.split(':');
  for (const perm of userPerms) {
    const [pRes, pAct] = perm.split(':');
    if (pRes === '*' || pRes === reqRes) {
      if (pAct === '*' || pAct === reqAct) return true;
    }
  }
  return false;
}

// Storage helpers

const STORAGE_KEY = 'agentic_obs_auth';

function saveAuth(tokens: AuthTokens, user: AuthUser) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tokens, user, savedAt: Date.now() }));
  } catch {
    /* ignore storage errors */
  }
}

function loadAuth(): { tokens: AuthTokens; user: AuthUser } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { tokens: AuthTokens; user: AuthUser; savedAt: number };
    return parsed;
  } catch {
    return null;
  }
}

function clearAuth() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

// Context

const AuthContext = createContext<AuthContextValue>({
  user: null,
  tokens: null,
  loading: true,
  login: () => {},
  logout: async () => {},
  hasPermission: () => false,
  isAdmin: false,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [tokens, setTokens] = useState<AuthTokens | null>(null);
  const [loading, setLoading] = useState(true);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleRefresh = useCallback((tok: AuthTokens) => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    // Refresh 60 seconds before expiry
    const delayMs = Math.max((tok.expiresIn - 60) * 1000, 5_000);
    refreshTimer.current = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch('/api/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: tok.refreshToken }),
          });
          if (res.ok) {
            const data = (await res.json()) as { tokens: AuthTokens };
            if (user) saveAuth(data.tokens, user);
            scheduleRefresh(data.tokens);
          } else {
            // Refresh failed - force logout
            clearAuth();
            setUser(null);
            setTokens(null);
          }
        } catch {
          /* network error - will retry on next render */
        }
      })();
    }, delayMs);
  }, [user]);

  // Restore session from localStorage on mount
  useEffect(() => {
    const saved = loadAuth();
    if (saved) {
      setUser(saved.user);
      setTokens(saved.tokens);
      scheduleRefresh(saved.tokens);
    }
    setLoading(false);
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(
    (newTokens: AuthTokens, newUser: AuthUser) => {
      setUser(newUser);
      setTokens(newTokens);
      saveAuth(newTokens, newUser);
      scheduleRefresh(newTokens);
    },
    [scheduleRefresh],
  );

  const logout = useCallback(async () => {
    if (tokens) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        });
      } catch {
        /* ignore */
      }
    }
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    clearAuth();
    setUser(null);
    setTokens(null);
  }, [tokens]);

  const hasPermission = useCallback(
    (permission: string) => {
      if (!user) return false;
      const perms = ROLE_PERMISSIONS[user.role] ?? [];
      return checkPermission(perms, permission);
    },
    [user],
  );

  return (
    <AuthContext.Provider
      value={{
        user,
        tokens,
        loading,
        login,
        logout,
        hasPermission,
        isAdmin: user?.role === 'admin',
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

export function usePermission(permission: string): boolean {
  const { hasPermission } = useAuth();
  return hasPermission(permission);
}
