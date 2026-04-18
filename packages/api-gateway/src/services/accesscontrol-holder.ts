/**
 * AccessControlHolder — a trivial late-binding wrapper.
 *
 * `server.ts` registers the dashboard / chat routers synchronously but the
 * real `AccessControlService` is built inside an async IIFE (it depends on
 * the RBAC repos and folder cascade resolvers). To avoid restructuring the
 * whole boot sequence, routers receive this holder which forwards calls once
 * the real service has been bound.
 *
 * Any call that arrives before `.set()` throws — that's a boot-ordering bug,
 * not a permission-check failure. We prefer loud failure to silent bypass.
 */

import type {
  Evaluator,
  Identity,
  ResolvedPermission,
} from '@agentic-obs/common';
import type { AccessControlService } from './accesscontrol-service.js';

/**
 * Minimal structural type the holder exposes. Matches the surface
 * `IAccessControlService` in `@agentic-obs/agent-core` plus the getters used
 * by other routes (getUserPermissions / ensurePermissions).
 */
export interface AccessControlSurface {
  getUserPermissions(identity: Identity): Promise<ResolvedPermission[]>;
  evaluate(identity: Identity, evaluator: Evaluator): Promise<boolean>;
  ensurePermissions(identity: Identity): Promise<ResolvedPermission[]>;
  filterByPermission<T>(
    identity: Identity,
    items: readonly T[],
    buildEvaluator: (item: T) => Evaluator,
  ): Promise<T[]>;
}

export class AccessControlHolder implements AccessControlSurface {
  private impl: AccessControlService | null = null;

  set(impl: AccessControlService): void {
    this.impl = impl;
  }

  private get service(): AccessControlService {
    if (!this.impl) {
      throw new Error(
        'AccessControlHolder: service not bound yet. The auth subsystem ' +
          'finishes wiring asynchronously at boot; route handlers that ' +
          'consult RBAC should not execute before that resolves.',
      );
    }
    return this.impl;
  }

  getUserPermissions(identity: Identity): Promise<ResolvedPermission[]> {
    return this.service.getUserPermissions(identity);
  }

  evaluate(identity: Identity, evaluator: Evaluator): Promise<boolean> {
    return this.service.evaluate(identity, evaluator);
  }

  ensurePermissions(identity: Identity): Promise<ResolvedPermission[]> {
    return this.service.ensurePermissions(identity);
  }

  filterByPermission<T>(
    identity: Identity,
    items: readonly T[],
    buildEvaluator: (item: T) => Evaluator,
  ): Promise<T[]> {
    return this.service.filterByPermission(identity, items, buildEvaluator);
  }
}
