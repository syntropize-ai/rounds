/**
 * Test-only helpers for constructing agents in unit/integration tests.
 *
 * Not exported from the package barrel — these are internal to agent-core
 * tests and to integration tests that spin up a real OrchestratorAgent with
 * a mock identity.
 */

import type { Evaluator, Identity, OrgRole } from '@agentic-obs/common';
import type { IAccessControlService } from './types-permissions.js';

export interface MakeTestIdentityOptions {
  userId?: string;
  orgId?: string;
  orgRole?: OrgRole;
  isServerAdmin?: boolean;
  serviceAccountId?: string;
}

/**
 * Construct a plausible `Identity` for tests. Defaults to an Admin principal
 * so existing orchestrator tests that don't care about permissions don't
 * trip the gate. Callers who need narrow permissions should pass
 * `orgRole: 'Viewer'` and pair it with an `AccessControlStub` that denies
 * writes.
 */
export function makeTestIdentity(
  overrides: MakeTestIdentityOptions = {},
): Identity {
  return {
    userId: overrides.userId ?? 'test-user',
    orgId: overrides.orgId ?? 'test-org',
    orgRole: overrides.orgRole ?? 'Admin',
    isServerAdmin: overrides.isServerAdmin ?? false,
    authenticatedBy: overrides.serviceAccountId ? 'api_key' : 'session',
    ...(overrides.serviceAccountId ? { serviceAccountId: overrides.serviceAccountId } : {}),
  };
}

/**
 * Stub access control that honors a predicate per (identity, evaluator). The
 * default predicate returns true for every check — matches the "Admin" role
 * default of `makeTestIdentity`. Tests that want to assert denial wrap the
 * stub with a custom predicate.
 */
export class AccessControlStub implements IAccessControlService {
  constructor(
    private readonly predicate: (
      identity: Identity,
      evaluator: Evaluator,
    ) => boolean = () => true,
  ) {}

  evaluate(identity: Identity, evaluator: Evaluator): Promise<boolean> {
    return Promise.resolve(this.predicate(identity, evaluator));
  }

  async filterByPermission<T>(
    identity: Identity,
    items: readonly T[],
    buildEvaluator: (item: T) => Evaluator,
  ): Promise<T[]> {
    const kept: T[] = [];
    for (const item of items) {
      if (this.predicate(identity, buildEvaluator(item))) kept.push(item);
    }
    return kept;
  }
}
