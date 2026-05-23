/**
 * Thin REST wrappers for connector policies + team lookup. Pulled out of the
 * components so tests can inject a recording double without dragging in the
 * real fetch layer.
 */
import {
  type ConnectorHumanPolicy,
  type ConnectorPolicy,
  type ConnectorPolicyScope,
  type ConnectorSubjectType,
} from '@agentic-obs/common';
import { apiClient } from '../../api/client.js';

export interface PolicyUpsertBody {
  subjectType: ConnectorSubjectType;
  subjectId: string;
  capability: string;
  humanPolicy: ConnectorHumanPolicy;
  scope?: ConnectorPolicyScope | null;
}

export interface PoliciesApi {
  list(
    connectorId: string,
    subjectType: ConnectorSubjectType,
    subjectId: string,
  ): Promise<ConnectorPolicy[]>;
  listTeams(): Promise<Array<{ id: string; name: string }>>;
  upsert(connectorId: string, body: PolicyUpsertBody): Promise<ConnectorPolicy>;
  remove(
    connectorId: string,
    subjectType: ConnectorSubjectType,
    subjectId: string,
    capability: string,
  ): Promise<void>;
}

export const defaultPoliciesApi: PoliciesApi = {
  async list(connectorId, subjectType, subjectId) {
    const qs = new URLSearchParams({ subjectType, subjectId }).toString();
    const { data, error } = await apiClient.get<{ policies: ConnectorPolicy[] }>(
      `/connectors/${encodeURIComponent(connectorId)}/policies?${qs}`,
    );
    if (error) throw new Error(error.message ?? 'Failed to load policies');
    return data?.policies ?? [];
  },
  async listTeams() {
    const { data, error } = await apiClient.get<{
      teams?: Array<{ id: string; name: string }>;
    }>(`/teams/search?perpage=200`);
    if (error) throw new Error(error.message ?? 'Failed to load teams');
    return (data?.teams ?? []).map((t) => ({ id: t.id, name: t.name }));
  },
  async upsert(connectorId, body) {
    const { data, error } = await apiClient.put<{ policy: ConnectorPolicy }>(
      `/connectors/${encodeURIComponent(connectorId)}/policies`,
      body,
    );
    if (error) throw new Error(error.message ?? 'Failed to save policy');
    if (!data?.policy) throw new Error('Empty response from policy upsert');
    return data.policy;
  },
  async remove(connectorId, subjectType, subjectId, capability) {
    const { error } = await apiClient.delete<unknown>(
      `/connectors/${encodeURIComponent(connectorId)}/policies/${encodeURIComponent(
        subjectType,
      )}/${encodeURIComponent(subjectId)}/${encodeURIComponent(capability)}`,
    );
    if (error) throw new Error(error.message ?? 'Failed to delete policy');
  },
};
