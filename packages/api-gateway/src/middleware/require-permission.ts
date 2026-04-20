/**
 * requirePermission — Express middleware factory that gates a route behind an
 * evaluator.
 *
 * Usage:
 *   router.post('/dashboards',
 *     requirePermission(ac.eval('dashboards:create', 'folders:*')),
 *     handler,
 *   );
 *
 *   router.get('/dashboards/:uid',
 *     requirePermission((req) => ac.eval('dashboards:read', `dashboards:uid:${req.params.uid}`)),
 *     handler,
 *   );
 *
 * The evaluator argument is either a concrete Evaluator or a factory
 * `(req) => Evaluator` — the latter lets handlers read `req.params` before
 * building the check.
 *
 * On deny: 403 `{ error: { code: 'FORBIDDEN', message: 'User has no permission to <evaluator.string()>' } }`.
 * On allow: `next()`.
 *
 * Request-scoped cache: after the first resolution, `req.auth.permissions` is
 * populated so subsequent checks on the same request do not re-query the DB.
 */

import type { NextFunction, Response } from 'express';
import type { Evaluator } from '@agentic-obs/common';
import type { AuthenticatedRequest } from './auth.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';

export type EvaluatorFactory = (req: AuthenticatedRequest) => Evaluator;

/**
 * Accepts either the real `AccessControlService` or the late-binding
 * `AccessControlHolder` — both implement `AccessControlSurface` (they only
 * need `evaluate()` here). Late binding is required for routes mounted
 * outside the auth-subsystem IIFE (e.g. `/api/datasources` — it runs
 * pre-bootstrap before `accessControl` is constructed).
 */
export function createRequirePermission(ac: AccessControlSurface) {
  return function requirePermission(
    evaluatorOrFactory: Evaluator | EvaluatorFactory,
  ) {
    return async function permissionGate(
      req: AuthenticatedRequest,
      res: Response,
      next: NextFunction,
    ): Promise<void> {
      if (!req.auth) {
        res.status(401).json({
          error: { code: 'UNAUTHORIZED', message: 'authentication required' },
        });
        return;
      }

      let evaluator: Evaluator;
      try {
        evaluator =
          typeof evaluatorOrFactory === 'function'
            ? evaluatorOrFactory(req)
            : evaluatorOrFactory;
      } catch (err) {
        res.status(500).json({
          error: {
            code: 'INTERNAL_ERROR',
            message: `permission check failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
        return;
      }

      try {
        const allowed = await ac.evaluate(req.auth, evaluator);
        if (!allowed) {
          res.status(403).json({
            error: {
              code: 'FORBIDDEN',
              message: `User has no permission to ${evaluator.string()}`,
            },
          });
          return;
        }
        next();
      } catch (err) {
        res.status(500).json({
          error: {
            code: 'INTERNAL_ERROR',
            message: `permission check failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
      }
    };
  };
}
