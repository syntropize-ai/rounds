import { apiClient } from './rest-api.js';

export interface GitHubChangeSource {
  id: string;
  orgId: string;
  name: string;
  owner?: string;
  repo?: string;
  events: string[];
  active: boolean;
  createdAt: string;
  lastEventAt: string | null;
  webhookPath: string;
  secretMasked: string;
  secret?: string;
}

export interface CreateGitHubChangeSourceInput {
  name: string;
  owner?: string;
  repo?: string;
  events: string[];
  secret?: string;
  active?: boolean;
}

export const githubChangeSourcesApi = {
  async list(): Promise<GitHubChangeSource[]> {
    const res = await apiClient.get<{ sources: GitHubChangeSource[] }>('/connectors');
    if (res.error) throw new Error(res.error.message ?? 'Failed to load GitHub sources');
    return res.data.sources ?? [];
  },

  async create(input: CreateGitHubChangeSourceInput): Promise<GitHubChangeSource> {
    const res = await apiClient.post<{ source: GitHubChangeSource }>('/connectors', input);
    if (res.error) throw new Error(res.error.message ?? 'Failed to create GitHub source');
    return res.data.source;
  },

  async delete(id: string): Promise<void> {
    const res = await apiClient.delete<{ ok: boolean }>(`/connectors/${encodeURIComponent(id)}`);
    if (res.error) throw new Error(res.error.message ?? 'Failed to delete GitHub source');
  },
};
