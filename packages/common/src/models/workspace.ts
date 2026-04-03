export interface Workspace {
  id: string;
  name: string;
  slug: string; // URL-friendly identifier
  ownerId: string;
  members: WorkspaceMember[];
  settings: WorkspaceSettings;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMember {
  userId: string;
  role: 'owner' | 'admin' | 'editor' | 'viewer';
  joinedAt: string;
}

export interface WorkspaceSettings {
  defaultLlmModel?: string;
  defaultDatasourceId?: string;
  maxDashboards?: number;
  maxAlertRules?: number;
}
