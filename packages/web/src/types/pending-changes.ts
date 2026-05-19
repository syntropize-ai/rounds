/**
 * PendingChange — minimal structural type for agent-proposed dashboard edits.
 *
 * The backend `pending_changes` row maps to this shape via the JSON returned
 * by `/api/dashboards/:id/pending-changes`. Defined locally so the web bundle
 * doesn't depend on backend type generation; structural match is enough.
 */

export type PendingChangeKind =
  | 'modify_panel'
  | 'add_panel'
  | 'remove_panel'
  | 'set_title'
  | 'add_variable';

export type PendingChangeStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'expired';

export interface PendingChange {
  id: string;
  orgId: string;
  dashboardId: string;
  panelId: string | null;
  proposedBy: string;
  proposedAt: string;
  status: PendingChangeStatus;
  changeKind: PendingChangeKind;
  beforeJson: unknown | null;
  afterJson: unknown;
  summary: string;
  expiresAt: string;
}

export interface PendingChangeCountByDashboard {
  dashboardId: string;
  dashboardTitle: string;
  count: number;
  changes: Array<{
    id: string;
    panelId: string | null;
    summary: string;
    changeKind: PendingChangeKind;
  }>;
}

export interface PendingChangeCount {
  count: number;
  byDashboard: PendingChangeCountByDashboard[];
}
