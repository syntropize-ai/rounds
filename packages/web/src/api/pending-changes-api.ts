/**
 * Pending-changes REST surface.
 *
 * Endpoints (mounted under /api by the gateway):
 *   GET    /dashboards/:id/pending-changes
 *   GET    /pending-changes/count
 *   POST   /dashboards/:id/pending-changes/:cid/accept
 *   POST   /dashboards/:id/pending-changes/:cid/reject
 *   POST   /dashboards/:id/pending-changes/accept-all   body: { ids }
 *   POST   /dashboards/:id/pending-changes/reject-all   body: { ids }
 */

import { apiClient } from './rest-api.js';
import type {
  PendingChange,
  PendingChangeCount,
} from '../types/pending-changes.js';

export const pendingChangesApi = {
  async listForDashboard(
    dashboardId: string,
    status?: 'pending' | 'accepted' | 'rejected' | 'expired',
  ): Promise<PendingChange[]> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    const { data, error } = await apiClient.get<{ changes: PendingChange[] }>(
      `/dashboards/${encodeURIComponent(dashboardId)}/pending-changes${qs}`,
    );
    if (error) throw new Error(error.message ?? 'Failed to load pending changes');
    return data?.changes ?? [];
  },

  async count(): Promise<PendingChangeCount> {
    const { data, error } = await apiClient.get<PendingChangeCount>(
      '/pending-changes/count',
    );
    if (error) throw new Error(error.message ?? 'Failed to load count');
    return data ?? { count: 0, byDashboard: [] };
  },

  async accept(dashboardId: string, changeId: string): Promise<void> {
    const { error } = await apiClient.post<unknown>(
      `/dashboards/${encodeURIComponent(dashboardId)}/pending-changes/${encodeURIComponent(changeId)}/accept`,
      {},
    );
    if (error) throw new Error(error.message ?? 'Accept failed');
  },

  async reject(dashboardId: string, changeId: string): Promise<void> {
    const { error } = await apiClient.post<unknown>(
      `/dashboards/${encodeURIComponent(dashboardId)}/pending-changes/${encodeURIComponent(changeId)}/reject`,
      {},
    );
    if (error) throw new Error(error.message ?? 'Reject failed');
  },

  async acceptAll(dashboardId: string, ids: string[]): Promise<void> {
    const { error } = await apiClient.post<unknown>(
      `/dashboards/${encodeURIComponent(dashboardId)}/pending-changes/accept-all`,
      { ids },
    );
    if (error) throw new Error(error.message ?? 'Accept-all failed');
  },

  async rejectAll(dashboardId: string, ids: string[]): Promise<void> {
    const { error } = await apiClient.post<unknown>(
      `/dashboards/${encodeURIComponent(dashboardId)}/pending-changes/reject-all`,
      { ids },
    );
    if (error) throw new Error(error.message ?? 'Reject-all failed');
  },
};

/** Polling interval (ms) for the global nav badge. SSE handles real-time
 *  updates when present; this is the fallback heartbeat. */
export const PENDING_CHANGES_POLL_MS = 30_000;
