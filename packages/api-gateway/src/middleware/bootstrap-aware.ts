/**
 * Bootstrap-aware middleware (W2 / T2.5).
 *
 * While the instance has never been bootstrapped (`instance_settings.
 * bootstrapped_at` is unset), the setup wizard needs to save the initial
 * LLM / datasource / notification config before the first admin exists
 * — i.e. before any user can authenticate. Once the first admin is
 * created (see `POST /api/setup/admin` in routes/setup.ts), the marker
 * is written and every further request must authenticate and satisfy
 * the permission gate.
 *
 * This middleware short-circuits the auth chain in the pre-bootstrap
 * window and delegates to the normal auth+permission chain afterwards.
 *
 * Contrast with the old "bootstrap check on every setup route" pattern,
 * which re-checked `users.list()` repeatedly — flimsy because a
 * restored-from-backup DB could look empty even in a long-running
 * instance. The marker is durable.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { SetupConfigService } from '../services/setup-config-service.js';

export interface BootstrapAwareDeps {
  setupConfig: SetupConfigService;
  authMiddleware: RequestHandler;
  /**
   * Additional middlewares to run in order AFTER auth succeeds,
   * post-bootstrap only. Typical usage: org-context + permission gate.
   */
  postAuthChain?: RequestHandler[];
}

/**
 * Returns a middleware that lets unauthenticated requests through while
 * the instance is pre-bootstrap, and otherwise defers to the supplied
 * auth middleware followed by the post-auth chain (org context +
 * permission check, etc.).
 */
export function bootstrapAware(deps: BootstrapAwareDeps): RequestHandler {
  const { setupConfig, authMiddleware, postAuthChain = [] } = deps;
  return function bootstrapAwareMw(req: Request, res: Response, next: NextFunction): void {
    void setupConfig
      .isBootstrapped()
      .then((bootstrapped) => {
        res.locals['isBootstrapped'] = bootstrapped;
        if (!bootstrapped) {
          next();
          return;
        }
        // Post-bootstrap: require auth, then walk the chain.
        const chain = [authMiddleware, ...postAuthChain];
        let i = 0;
        const step = (err?: unknown): void => {
          if (err) {
            next(err);
            return;
          }
          if (res.headersSent) return;
          if (i >= chain.length) {
            next();
            return;
          }
          const mw = chain[i++]!;
          mw(req, res, step);
        };
        step();
      })
      .catch((err) => {
        next(err);
      });
  };
}
