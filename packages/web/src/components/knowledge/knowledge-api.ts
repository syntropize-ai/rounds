/**
 * Thin REST wrapper for /api/kb/entries. Mirrors connectors/policies-api.ts —
 * keeps the wire shape testable without dragging in the real fetch layer.
 *
 * Skill-style schema: entries are { title, description, body (markdown),
 * intentTags, sourceRef? }. The `kind` axis is gone.
 */
import type { KnowledgeEntry, KnowledgeSource } from '@agentic-obs/common';
import { apiClient } from '../../api/client.js';

export interface KnowledgeListFilter {
  source?: KnowledgeSource;
  limit?: number;
}

export interface KnowledgeCreateBody {
  title: string;
  description: string;
  body: string;
  intentTags: string[];
  sourceRef?: string | null;
}

export type KnowledgeUpdateBody = Partial<KnowledgeCreateBody>;

export interface KnowledgeApi {
  list(filter?: KnowledgeListFilter): Promise<KnowledgeEntry[]>;
  get(id: string): Promise<KnowledgeEntry>;
  create(body: KnowledgeCreateBody): Promise<KnowledgeEntry>;
  update(id: string, body: KnowledgeUpdateBody): Promise<KnowledgeEntry>;
  remove(id: string): Promise<void>;
}

function buildListQuery(filter?: KnowledgeListFilter): string {
  const params = new URLSearchParams();
  if (filter?.source) params.set('source', filter.source);
  if (filter?.limit !== undefined) params.set('limit', String(filter.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export const defaultKnowledgeApi: KnowledgeApi = {
  async list(filter) {
    const { data, error } = await apiClient.get<{ entries: KnowledgeEntry[] }>(
      `/kb/entries${buildListQuery(filter)}`,
    );
    if (error) throw new Error(error.message ?? 'Failed to load knowledge entries');
    return data?.entries ?? [];
  },
  async get(id) {
    const { data, error } = await apiClient.get<{ entry: KnowledgeEntry }>(
      `/kb/entries/${encodeURIComponent(id)}`,
    );
    if (error) throw new Error(error.message ?? 'Failed to load entry');
    if (!data?.entry) throw new Error('Empty response from entry get');
    return data.entry;
  },
  async create(body) {
    const { data, error } = await apiClient.post<{ entry: KnowledgeEntry }>(
      `/kb/entries`,
      body,
    );
    if (error) throw new Error(error.message ?? 'Failed to create entry');
    if (!data?.entry) throw new Error('Empty response from entry create');
    return data.entry;
  },
  async update(id, body) {
    const { data, error } = await apiClient.put<{ entry: KnowledgeEntry }>(
      `/kb/entries/${encodeURIComponent(id)}`,
      body,
    );
    if (error) throw new Error(error.message ?? 'Failed to update entry');
    if (!data?.entry) throw new Error('Empty response from entry update');
    return data.entry;
  },
  async remove(id) {
    const { error } = await apiClient.delete<unknown>(
      `/kb/entries/${encodeURIComponent(id)}`,
    );
    if (error) throw new Error(error.message ?? 'Failed to delete entry');
  },
};

export { buildListQuery };
