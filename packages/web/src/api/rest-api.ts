import type {
  ResourceKind,
  ResourcePermissionEntry,
  ResourcePermissionSetItem,
} from '@agentic-obs/common';
import { BASE_URL } from './config.js';
import { ApiClient } from './transport.js';

/**
 * Build the REST path for a resource's permissions endpoint. Mirrors
 * docs/auth-perm-design/08-api-surface.md §permissions. Exported for tests.
 */
export function resourcePermissionsPath(resource: ResourceKind, uid: string): string {
  switch (resource) {
    case 'folders':
      return `/folders/${encodeURIComponent(uid)}/permissions`;
    case 'dashboards':
      return `/dashboards/uid/${encodeURIComponent(uid)}/permissions`;
    case 'datasources':
      return `/datasources/${encodeURIComponent(uid)}/permissions`;
    case 'alert.rules':
      return `/access-control/alert.rules/${encodeURIComponent(uid)}/permissions`;
  }
}

export const apiClient = new ApiClient(BASE_URL);

/**
 * Throwing convenience wrapper around apiClient.
 *
 * apiClient methods return `{ data, error }`. For code paths that prefer to
 * bubble failures via thrown errors (try/catch) rather than early-return, use
 * these helpers — they throw an Error with the server message if the request
 * fails, otherwise return the data directly.
 */
export const api = {
  /** Base path relative to `/api` (no leading slash required in baseUrl). */
  baseUrl: BASE_URL,

  async get<T>(path: string): Promise<T> {
    const { data, error } = await apiClient.get<T>(path);
    if (error) throw new Error(error.message ?? 'Request failed');
    return data;
  },
  async post<T>(path: string, body: unknown): Promise<T> {
    const { data, error } = await apiClient.post<T>(path, body);
    if (error) throw new Error(error.message ?? 'Request failed');
    return data;
  },
  async put<T>(path: string, body: unknown): Promise<T> {
    const { data, error } = await apiClient.put<T>(path, body);
    if (error) throw new Error(error.message ?? 'Request failed');
    return data;
  },
  async patch<T>(path: string, body: unknown): Promise<T> {
    const { data, error } = await apiClient.patch<T>(path, body);
    if (error) throw new Error(error.message ?? 'Request failed');
    return data;
  },
  async delete<T>(path: string): Promise<T> {
    const { data, error } = await apiClient.delete<T>(path);
    if (error) throw new Error(error.message ?? 'Request failed');
    return data;
  },

  /**
   * List a resource's permissions. Returns the denormalized entry array used
   * by <PermissionsDialog>. See 08-api-surface.md §permissions.
   */
  async getResourcePermissions(
    resource: ResourceKind,
    uid: string,
  ): Promise<ResourcePermissionEntry[]> {
    const path = resourcePermissionsPath(resource, uid);
    const { data, error } = await apiClient.get<
      ResourcePermissionEntry[] | { items?: ResourcePermissionEntry[] }
    >(path);
    if (error) throw new Error(error.message ?? 'Request failed');
    // Grafana-parity sometimes wraps the list in `{ items }`; accept both.
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.items)) return data.items;
    return [];
  },

  /**
   * Bulk-replace a resource's direct permissions. Body is the full desired
   * state, not a diff — matches Grafana's permission PUT semantics.
   */
  async setResourcePermissions(
    resource: ResourceKind,
    uid: string,
    items: ResourcePermissionSetItem[],
  ): Promise<void> {
    const path = resourcePermissionsPath(resource, uid);
    const { error } = await apiClient.post<unknown>(path, { items });
    if (error) throw new Error(error.message ?? 'Request failed');
  },
};
