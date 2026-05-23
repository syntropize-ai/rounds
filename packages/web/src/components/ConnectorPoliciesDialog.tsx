// PR3 will rewrite this entire component for the new 3-pane Connectors page.
// PR1 only keeps it compiling under the new ConnectorPolicy shape; the live
// behavior (table, add-row, autocomplete, default seeds preview) is stubbed
// to a placeholder so the project typechecks and builds.
import React from 'react';
import {
  getConnectorTemplate,
  KNOWN_KUBERNETES_CAPABILITIES,
  type ConnectorHumanPolicy,
  type ConnectorPolicy,
  type ConnectorPolicyScope,
  type ConnectorType,
} from '@agentic-obs/common';
import { apiClient } from '../api/client.js';

export interface ConnectorPoliciesDialogConnector {
  id: string;
  name: string;
  type: string;
}

export interface PoliciesApi {
  list(connectorId: string): Promise<ConnectorPolicy[]>;
  listTeams(): Promise<Array<{ id: string; name: string }>>;
  upsert(connectorId: string, body: UpsertBody): Promise<ConnectorPolicy>;
  remove(
    connectorId: string,
    subjectType: ConnectorPolicy['subjectType'],
    subjectId: string,
    capability: string,
  ): Promise<void>;
}

export interface UpsertBody {
  subjectType: ConnectorPolicy['subjectType'];
  subjectId: string;
  capability: string;
  humanPolicy: ConnectorHumanPolicy;
  scope?: ConnectorPolicyScope | null;
}

export interface ConnectorPoliciesDialogProps {
  connector: ConnectorPoliciesDialogConnector;
  onClose: () => void;
  /** Optional override — primarily for tests. */
  api?: PoliciesApi;
}

export const HUMAN_POLICY_OPTIONS: ConnectorHumanPolicy[] = ['allow', 'ask', 'block'];

/**
 * Capability strings have the shape `<area>.<verb>` — lowercase letters,
 * digits, and underscores only, with exactly one dot.
 */
export const CAPABILITY_REGEX = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export function isValidCapability(s: string): boolean {
  return CAPABILITY_REGEX.test(s);
}

export function parseScope(
  raw: string,
): { ok: true; value: ConnectorPolicyScope | null } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: 'Scope must be a JSON object' };
    }
    return { ok: true, value: parsed as ConnectorPolicyScope };
  } catch {
    return { ok: false, message: 'Scope must be valid JSON' };
  }
}

export function canSubmitAdd(args: {
  subjectType?: ConnectorPolicy['subjectType'];
  subjectId?: string;
  capability: string;
  humanPolicy: string;
  scopeRaw: string;
}): boolean {
  if (!args.capability) return false;
  if (!isValidCapability(args.capability)) return false;
  if (!args.humanPolicy) return false;
  const scope = parseScope(args.scopeRaw);
  return scope.ok;
}

export function capabilitiesFor(type: string): readonly string[] {
  if (type === 'kubernetes') return KNOWN_KUBERNETES_CAPABILITIES;
  try {
    return getConnectorTemplate(type as ConnectorType).capabilities ?? [];
  } catch {
    return [];
  }
}

export const defaultApi: PoliciesApi = {
  async list(connectorId) {
    const { data, error } = await apiClient.get<{ policies: ConnectorPolicy[] }>(
      `/connectors/${encodeURIComponent(connectorId)}/policies`,
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

// PR3 will rewrite this component. For now render nothing usable — the
// Settings → Connectors tab is being removed in PR4 anyway.
export function ConnectorPoliciesDialog(
  _props: ConnectorPoliciesDialogProps,
): React.ReactElement | null {
  return null;
}

export default ConnectorPoliciesDialog;
