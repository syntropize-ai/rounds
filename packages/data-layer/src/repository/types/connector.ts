import type {
  Connector,
  ConnectorLookupOptions,
  ConnectorSecret,
  ConnectorTeamPolicy,
  ListConnectorPoliciesOptions,
  ListConnectorsOptions,
  NewConnector,
  UpsertConnectorSecret,
  UpsertConnectorTeamPolicy,
  ConnectorPatch,
} from '@agentic-obs/common';

export interface IConnectorRepository {
  list(opts: ListConnectorsOptions): Promise<Connector[]>;
  get(id: string, opts: ConnectorLookupOptions): Promise<Connector | null>;
  create(input: NewConnector): Promise<Connector>;
  update(id: string, patch: ConnectorPatch, orgId: string): Promise<Connector | null>;
  delete(id: string, orgId: string): Promise<boolean>;
  count(orgId: string): Promise<number>;
  findByCapability(orgId: string, capability: string): Promise<Connector[]>;

  getSecret(connectorId: string): Promise<ConnectorSecret | null>;
  upsertSecret(input: UpsertConnectorSecret): Promise<ConnectorSecret>;
  deleteSecret(connectorId: string): Promise<boolean>;

  listPolicies(opts: ListConnectorPoliciesOptions): Promise<ConnectorTeamPolicy[]>;
  getPolicy(
    connectorId: string,
    teamId: string,
    capability: string,
  ): Promise<ConnectorTeamPolicy | null>;
  upsertPolicy(input: UpsertConnectorTeamPolicy): Promise<ConnectorTeamPolicy>;
  deletePolicy(connectorId: string, teamId: string, capability: string): Promise<boolean>;
}
