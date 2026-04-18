/**
 * AuthContext — server-backed auth + permission state.
 *
 * Replaces the prior role → permissions lookup with the real `/api/user`
 * and `/api/user/permissions` responses. `hasPermission(action, scope?)`
 * is the only authorization primitive exposed to the UI; it matches scope
 * strings using the shared helper from `@agentic-obs/common/rbac/scope`
 * (identical wildcard semantics to the backend evaluator).
 *
 * See docs/auth-perm-design/09-frontend.md §T8.8.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { scopeCovers } from '@agentic-obs/common';
import type { OrgRole } from '@agentic-obs/common';
import {
  authApi,
  AuthApiError,
  type CurrentUser,
  type OrgMembership,
  type UserPermissions,
} from '../api/client.js';

export type { OrgRole };
export type OrgSummary = OrgMembership;

export interface AuthUser {
  id: string;
  email: string;
  login: string;
  name: string;
  theme: string;
  orgId: string;
  isServerAdmin: boolean;
  authLabels: string[];
  isDisabled: boolean;
  isExternal: boolean;
  avatarUrl?: string;
}

export interface AuthState {
  user: AuthUser | null;
  currentOrg: OrgMembership | null;
  orgs: OrgMembership[];
  isServerAdmin: boolean;
  permissions: UserPermissions;
  loading: boolean;
  error: string | null;
}

export interface AuthApi {
  login(body: { user: string; password: string }): Promise<void>;
  logout(): Promise<void>;
  hasPermission(action: string, scope?: string): boolean;
  switchOrg(orgId: string): Promise<void>;
  refresh(): Promise<void>;
}

export type AuthContextValue = AuthState & AuthApi;

// Internal helpers

export function toAuthUser(me: CurrentUser): AuthUser {
  return {
    id: me.id,
    email: me.email,
    login: me.login,
    name: me.name,
    theme: me.theme,
    orgId: me.orgId,
    // Backend sends Grafana-compat key name; internally we use `isServerAdmin`.
    isServerAdmin: me.isGrafanaAdmin,
    authLabels: me.authLabels,
    isDisabled: me.isDisabled,
    isExternal: me.isExternal,
    avatarUrl: me.avatarUrl,
  };
}

export function pickCurrentOrg(me: CurrentUser): OrgMembership | null {
  return me.orgs.find((o) => o.orgId === me.orgId) ?? me.orgs[0] ?? null;
}

/**
 * Pure permission check. Exported for tests; the hook wraps this with the
 * current context's `permissions` map.
 */
export function checkPermission(
  permissions: UserPermissions,
  action: string,
  scope?: string,
): boolean {
  const scopes = permissions[action];
  if (!scopes || scopes.length === 0) return false;
  if (!scope) return true;
  return scopes.some((s) => s === '' || s === scope || scopeCovers(s, scope));
}

const INITIAL_STATE: AuthState = {
  user: null,
  currentOrg: null,
  orgs: [],
  isServerAdmin: false,
  permissions: {},
  loading: true,
  error: null,
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(INITIAL_STATE);
  // Guard against state updates after unmount.
  const mountedRef = useRef(true);

  const applyLoaded = useCallback(
    (me: CurrentUser, permissions: UserPermissions) => {
      if (!mountedRef.current) return;
      setState({
        user: toAuthUser(me),
        currentOrg: pickCurrentOrg(me),
        orgs: me.orgs,
        isServerAdmin: me.isGrafanaAdmin,
        permissions,
        loading: false,
        error: null,
      });
    },
    [],
  );

  const applyUnauthenticated = useCallback(() => {
    if (!mountedRef.current) return;
    setState({
      user: null,
      currentOrg: null,
      orgs: [],
      isServerAdmin: false,
      permissions: {},
      loading: false,
      error: null,
    });
  }, []);

  const fetchAll = useCallback(async () => {
    // Fetch current user + permissions in parallel. Both come from cookie auth.
    const [me, perms] = await Promise.all([
      authApi.getCurrentUser(),
      authApi.getUserPermissions(),
    ]);
    applyLoaded(me, perms);
  }, [applyLoaded]);

  const refresh = useCallback(async () => {
    try {
      await fetchAll();
    } catch (err) {
      if (err instanceof AuthApiError && err.status === 401) {
        applyUnauthenticated();
        return;
      }
      if (mountedRef.current) {
        setState((prev) => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load session',
        }));
      }
    }
  }, [fetchAll, applyUnauthenticated]);

  // Restore session on mount.
  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  const login = useCallback<AuthApi['login']>(
    async (body) => {
      // POST /api/login sets the session cookie; on success we pull user + perms.
      await authApi.login(body);
      await fetchAll();
    },
    [fetchAll],
  );

  const logout = useCallback<AuthApi['logout']>(async () => {
    try {
      await authApi.logout();
    } catch {
      // Swallow transport errors on logout — we still clear local state.
    }
    applyUnauthenticated();
  }, [applyUnauthenticated]);

  const switchOrg = useCallback<AuthApi['switchOrg']>(
    async (orgId) => {
      await authApi.switchOrg(orgId);
      // Refetch user + permissions so scoped lists rehydrate for the new org.
      await fetchAll();
    },
    [fetchAll],
  );

  const hasPermission = useCallback<AuthApi['hasPermission']>(
    (action, scope) => checkPermission(state.permissions, action, scope),
    [state.permissions],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      login,
      logout,
      hasPermission,
      switchOrg,
      refresh,
    }),
    [state, login, logout, hasPermission, switchOrg, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/**
 * Renders `children` when `hasPermission(action, scope?)` is true,
 * otherwise renders `fallback` (defaults to null).
 */
export function PermissionGate({
  action,
  scope,
  fallback = null,
  children,
}: {
  action: string;
  scope?: string;
  fallback?: ReactNode;
  children: ReactNode;
}): React.ReactElement | null {
  const { hasPermission } = useAuth();
  return <>{hasPermission(action, scope) ? children : fallback}</>;
}
