import { api } from './rest-api.js';

/**
 * Typed admin-surface endpoints consumed by the tabs in `pages/admin/`.
 * Each call is a thin wrapper around `api.*` so the admin UI can reference
 * a single catalog of endpoint paths. Paths match 08-api-surface.md.
 *
 * Response types intentionally live here as `unknown`: the admin tabs parse
 * the DTOs themselves (see `pages/admin/_shared.ts`) to tolerate minor
 * backend DTO drift without requiring a coordinated deploy.
 */
export const adminApi = {
  users: {
    listOrg: (qs: string): Promise<unknown> => api.get(`/org/users${qs}`),
    listAdmin: (qs: string): Promise<unknown> => api.get(`/admin/users${qs}`),
    create: (body: { name: string; login: string; email: string; password: string }): Promise<unknown> =>
      api.post('/admin/users', body),
    update: (id: string, body: Record<string, unknown>): Promise<unknown> =>
      api.put(`/admin/users/${id}`, body),
    delete: (id: string): Promise<unknown> => api.delete(`/admin/users/${id}`),
    disable: (id: string): Promise<unknown> => api.post(`/admin/users/${id}/disable`, {}),
    enable: (id: string): Promise<unknown> => api.post(`/admin/users/${id}/enable`, {}),
    resetPassword: (id: string): Promise<unknown> => api.post(`/admin/users/${id}/password`, {}),
    logoutAllSessions: (id: string): Promise<unknown> => api.post(`/admin/users/${id}/logout`, {}),
    authTokens: (id: string): Promise<unknown> => api.get(`/admin/users/${id}/auth-tokens`),
  },
  teams: {
    search: (qs: string): Promise<unknown> => api.get(`/teams/search${qs}`),
    get: (id: string): Promise<unknown> => api.get(`/teams/${id}`),
    create: (body: { name: string; email?: string }): Promise<unknown> => api.post('/teams', body),
    update: (id: string, body: { name?: string; email?: string }): Promise<unknown> =>
      api.put(`/teams/${id}`, body),
    delete: (id: string): Promise<unknown> => api.delete(`/teams/${id}`),
    members: (id: string): Promise<unknown> => api.get(`/teams/${id}/members`),
    addMember: (id: string, userId: string): Promise<unknown> =>
      api.post(`/teams/${id}/members`, { userId }),
    setMemberPermission: (id: string, userId: string, permission: number): Promise<unknown> =>
      api.put(`/teams/${id}/members/${userId}`, { permission }),
    removeMember: (id: string, userId: string): Promise<unknown> =>
      api.delete(`/teams/${id}/members/${userId}`),
    preferences: (id: string): Promise<unknown> => api.get(`/teams/${id}/preferences`),
    setPreferences: (id: string, body: Record<string, unknown>): Promise<unknown> =>
      api.put(`/teams/${id}/preferences`, body),
  },
  serviceAccounts: {
    search: (qs: string): Promise<unknown> => api.get(`/serviceaccounts/search${qs}`),
    create: (body: { name: string; role: string; isDisabled?: boolean }): Promise<unknown> =>
      api.post('/serviceaccounts', body),
    update: (id: string, body: Record<string, unknown>): Promise<unknown> =>
      api.patch(`/serviceaccounts/${id}`, body),
    delete: (id: string): Promise<unknown> => api.delete(`/serviceaccounts/${id}`),
    tokens: (id: string): Promise<unknown> => api.get(`/serviceaccounts/${id}/tokens`),
    createToken: (
      id: string,
      body: { name: string; secondsToLive?: number },
    ): Promise<{ id: string; name: string; key: string }> =>
      api.post(`/serviceaccounts/${id}/tokens`, body),
    deleteToken: (id: string, tokenId: string): Promise<unknown> =>
      api.delete(`/serviceaccounts/${id}/tokens/${tokenId}`),
  },
  roles: {
    list: (qs: string): Promise<unknown> => api.get(`/access-control/roles${qs}`),
    get: (uid: string): Promise<unknown> => api.get(`/access-control/roles/${uid}`),
    create: (body: Record<string, unknown>): Promise<unknown> =>
      api.post('/access-control/roles', body),
    update: (uid: string, body: Record<string, unknown>): Promise<unknown> =>
      api.put(`/access-control/roles/${uid}`, body),
    delete: (uid: string): Promise<unknown> => api.delete(`/access-control/roles/${uid}`),
    assignToUser: (
      userId: string,
      body: { roleUid: string; global?: boolean },
    ): Promise<unknown> => api.post(`/access-control/users/${userId}/roles`, body),
    unassignFromUser: (userId: string, roleUid: string): Promise<unknown> =>
      api.delete(`/access-control/users/${userId}/roles/${roleUid}`),
    teamRoles: (teamId: string): Promise<unknown> =>
      api.get(`/access-control/teams/${teamId}/roles`),
    assignToTeam: (teamId: string, roleUid: string): Promise<unknown> =>
      api.post(`/access-control/teams/${teamId}/roles`, { roleUid }),
    unassignFromTeam: (teamId: string, roleUid: string): Promise<unknown> =>
      api.delete(`/access-control/teams/${teamId}/roles/${roleUid}`),
  },
  orgs: {
    list: (qs: string): Promise<unknown> => api.get(`/orgs${qs}`),
    create: (body: { name: string }): Promise<unknown> => api.post('/orgs', body),
    rename: (id: string, body: { name: string }): Promise<unknown> => api.put(`/orgs/${id}`, body),
    delete: (id: string): Promise<unknown> => api.delete(`/orgs/${id}`),
  },
  auditLog: {
    list: (qs: string): Promise<unknown> => api.get(`/admin/audit-log${qs}`),
  },
};
