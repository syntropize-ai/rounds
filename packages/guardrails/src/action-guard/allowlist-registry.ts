/**
 * Central capability allowlist tuples for the GuardedAction model.
 *
 * Anything NOT listed here is denied by `ActionGuard.decide()`. The list is
 * deliberately small — tuples land here only after a deliberate review of
 * what (connector × capability × verb) combinations are safe to expose to
 * the agent.
 *
 * The allowlist is structured as named registries that callers compose
 * into the final `allowlist` they pass to `new ActionGuard({ allowlist })`.
 * Keeps the registry diffable and lets future plan-executor / agent layers
 * opt into different subsets.
 */

import type { CapabilityAllowEntry } from './action-guard.js';

/**
 * Tuples for the AI-first configuration tools added in Task 07. Connector
 * is `instance` (the gateway itself, treated as a logical connector for
 * config-plane writes). Verbs match the high-level operations the tools
 * expose; param validators stay light because the route layer already
 * enforces shape.
 */
export const CONFIG_PLANE_ALLOWLIST: readonly CapabilityAllowEntry[] = [
  { connectorId: 'instance', capability: 'datasource.config', verb: 'upsert' },
  { connectorId: 'instance', capability: 'datasource.config', verb: 'test' },
  { connectorId: 'instance', capability: 'ops_connector.config', verb: 'upsert' },
  { connectorId: 'instance', capability: 'ops_connector.config', verb: 'test' },
  { connectorId: 'instance', capability: 'instance.setting', verb: 'set' },
];
