import type { ConnectorCategory, ConnectorType } from './connector-template.js';

export type ConnectorStatus = 'draft' | 'active' | 'failed' | 'disabled';
export type ConnectorHumanPolicy = 'allow' | 'confirm' | 'strong_confirm' | 'deny';
export type ConnectorAgentPolicy = 'allow' | 'suggest' | 'formal_approval' | 'deny';

export type ConnectorConfig = Record<string, unknown>;
export type ConnectorPolicyScope = Record<string, unknown>;

export interface Connector {
  id: string;
  orgId: string;
  type: ConnectorType;
  name: string;
  config: ConnectorConfig;
  status: ConnectorStatus;
  lastVerifiedAt: string | null;
  lastVerifyError: string | null;
  isDefault: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  capabilities: string[];
  secretMissing: boolean;
  defaultFor?: ConnectorType | null;
}

export interface NewConnector {
  id?: string;
  orgId: string;
  type: ConnectorType;
  name: string;
  config?: ConnectorConfig;
  status?: ConnectorStatus;
  lastVerifiedAt?: string | null;
  lastVerifyError?: string | null;
  isDefault?: boolean;
  createdBy: string;
}

export interface ConnectorPatch {
  name?: string;
  config?: ConnectorConfig;
  status?: ConnectorStatus;
  lastVerifiedAt?: string | null;
  lastVerifyError?: string | null;
  isDefault?: boolean;
}

export interface ListConnectorsOptions {
  orgId: string;
  type?: ConnectorType;
  category?: ConnectorCategory;
  capability?: string;
  status?: ConnectorStatus;
}

export interface ConnectorLookupOptions {
  orgId: string;
}

export interface ConnectorSecret {
  connectorId: string;
  ciphertext: Uint8Array;
  keyVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertConnectorSecret {
  connectorId: string;
  ciphertext: Uint8Array;
  keyVersion: number;
}

export interface ConnectorTeamPolicy {
  connectorId: string;
  teamId: string;
  capability: string;
  scope: ConnectorPolicyScope | null;
  humanPolicy: ConnectorHumanPolicy;
  agentPolicy: ConnectorAgentPolicy;
}

export interface UpsertConnectorTeamPolicy {
  connectorId: string;
  teamId?: string;
  capability: string;
  scope?: ConnectorPolicyScope | null;
  humanPolicy: ConnectorHumanPolicy;
  agentPolicy: ConnectorAgentPolicy;
}

export interface ListConnectorPoliciesOptions {
  connectorId: string;
  teamId?: string;
  capability?: string;
}
