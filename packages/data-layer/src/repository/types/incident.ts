// Incident input parameter types — canonical home after store→repository
// migration (Sprint 4). The domain `Incident` type lives in @agentic-obs/common.

import type { IncidentStatus, IncidentSeverity } from '@agentic-obs/common';

export interface CreateIncidentParams {
  title: string;
  severity: IncidentSeverity;
  services?: string[];
  assignee?: string;
}

export interface UpdateIncidentParams {
  title?: string;
  status?: IncidentStatus;
  severity?: IncidentSeverity;
  services?: string[];
  assignee?: string;
}

export interface CreateIncidentParamsWithTenant extends CreateIncidentParams {
  tenantId?: string;
  workspaceId?: string;
}
