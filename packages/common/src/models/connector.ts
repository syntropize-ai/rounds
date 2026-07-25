import type { ConnectorCategory, ConnectorType } from './connector-template.js';

export type ConnectorStatus = 'draft' | 'active' | 'failed' | 'disabled';
export type ConnectorHumanPolicy = 'allow' | 'ask' | 'block';
export type ConnectorSubjectType = 'org' | 'team';

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
  /**
   * Decrypted secret bytes. The repository encrypts on write and decrypts on
   * read (AES-256-GCM under SECRET_KEY); only the DB column is ciphertext.
   */
  ciphertext: Uint8Array;
  /** Envelope version of the stored row. Owned by the repository. */
  keyVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertConnectorSecret {
  connectorId: string;
  /** Plaintext secret bytes — the repository encrypts them before storing. */
  ciphertext: Uint8Array;
}

export interface ConnectorPolicy {
  connectorId: string;
  subjectType: ConnectorSubjectType;
  subjectId: string;
  capability: string;
  scope: ConnectorPolicyScope | null;
  humanPolicy: ConnectorHumanPolicy;
}

export interface UpsertConnectorPolicy {
  connectorId: string;
  subjectType: ConnectorSubjectType;
  subjectId: string;
  capability: string;
  scope?: ConnectorPolicyScope | null;
  humanPolicy: ConnectorHumanPolicy;
}

export interface ListConnectorPoliciesOptions {
  connectorId: string;
  subjectType?: ConnectorSubjectType;
  subjectId?: string;
  capability?: string;
}
