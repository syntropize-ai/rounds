/**
 * Bootstrap defaults for connector policy rows.
 *
 * Runtime GuardedAction decisions are authorized by the PermissionChecker,
 * which api-gateway wires to `connector_team_policies`. These tuples are seed
 * material only: when a connector is created, the repository can use them as
 * initial policy rows if the template does not provide a stricter default.
 */

import type { CapabilityAllowEntry } from './action-guard.js';

export const CONNECTOR_POLICY_BOOTSTRAP_DEFAULTS: readonly CapabilityAllowEntry[] = [
  { connectorId: '*', capability: 'metrics.discover', verb: 'discover' },
  { connectorId: '*', capability: 'metrics.query', verb: 'query' },
  { connectorId: '*', capability: 'metrics.validate', verb: 'validate' },
  { connectorId: '*', capability: 'logs.query', verb: 'query' },
  { connectorId: '*', capability: 'logs.stream', verb: 'stream' },
  { connectorId: '*', capability: 'runtime.get', verb: 'get' },
  { connectorId: '*', capability: 'runtime.list', verb: 'list' },
  { connectorId: '*', capability: 'runtime.logs', verb: 'logs' },
  { connectorId: '*', capability: 'runtime.events', verb: 'events' },
];
