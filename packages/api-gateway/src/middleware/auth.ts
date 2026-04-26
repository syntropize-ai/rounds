/**
 * Authentication middleware.
 *
 * Resolves a request into `req.auth: Identity` by trying, in order:
 *   1. Cookie session (`openobs_session`) → SessionService lookup.
 *   2. Bearer token / x-api-key → ApiKeyRepository.
 *
 * On success, populates `req.auth` per docs/auth-perm-design/02-authentication.md
 * §identity-model. On failure, returns 401 with the canonical
 * `{ error: { code, message } }` envelope (see `error-handler.ts`).
 *
 * The old JWT / in-memory auth path is removed by design — Wave 6 handles
 * any back-compat concerns; do not reintroduce shims here.
 */

import type { NextFunction, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import type {
  Identity,
  IApiKeyRepository,
  IOrgUserRepository,
  IUserRepository,
} from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';
import type { SessionService } from '../auth/session-service.js';
import {
  SESSION_COOKIE_NAME,
} from '../auth/session-service.js';
import type { ApiKeyService } from '../services/apikey-service.js';

const log = createLogger('auth-mw');

export interface AuthenticatedRequest extends Request {
  auth?: Identity;
}

export interface AuthMiddlewareDeps {
  sessions: SessionService;
  users: IUserRepository;
  orgUsers: IOrgUserRepository;
  apiKeys: IApiKeyRepository;
  /**
   * ApiKeyService path (T6.3). When provided, the bearer-token branch goes
   * through `validateAndLookup` — which honours SA vs PAT, applies
   * rate-limited `apikey.used` audit, and enforces `is_disabled` on the
   * principal. When absent, the middleware falls back to the raw-repo path
   * used by pre-T6 test harnesses.
   */
  apiKeyService?: ApiKeyService;
}

/** Read a cookie value by name from the raw Cookie header. */
export function readCookie(
  cookieHeader: string | undefined,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=') || null;
  }
  return null;
}

function bearerToken(req: Request): string | null {
  const h = req.headers['authorization'];
  if (typeof h === 'string' && h.startsWith('Bearer ')) {
    return h.slice('Bearer '.length).trim();
  }
  const xkey = req.headers['x-api-key'];
  if (typeof xkey === 'string' && xkey.length > 0) return xkey;
  return null;
}

function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

// — Module-level middleware singleton ——————————————————————————
//
// Several existing route files import a default `authMiddleware` function.
// Rather than rewriting every one of them, we expose a wrapper that
// delegates to the middleware built by `createAuthMiddleware`.
// `createApp()` (via `app/auth-routes.ts::buildAuthSubsystem`) registers
// the real implementation at boot via `setAuthMiddleware` BEFORE any
// route files are mounted, so the wrapper has always been bound by the
// time a request arrives.
//
// If something tries to invoke the middleware before binding, that is a
// programming error in the boot sequence — fail loudly rather than
// silently 503'ing a request that should never have happened.

type MW = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => Promise<void> | void;

let resolvedMiddleware: MW | null = null;

export function setAuthMiddleware(mw: MW | null): void {
  resolvedMiddleware = mw;
}

export function getAuthMiddleware(): MW | null {
  return resolvedMiddleware;
}

export function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  if (!resolvedMiddleware) {
    throw new Error(
      'authMiddleware invoked before setAuthMiddleware — boot sequence is broken',
    );
  }
  void resolvedMiddleware(req, res, next);
}

export function createAuthMiddleware(deps: AuthMiddlewareDeps) {
  return async function authMiddleware(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const cookieHeader = req.headers['cookie'];
    const rawSessionToken = readCookie(cookieHeader, SESSION_COOKIE_NAME);

    // 1. Cookie session.
    if (rawSessionToken) {
      try {
        const row = await deps.sessions.lookupByToken(rawSessionToken);
        if (!row) {
          res.status(401).json({
            error: { code: 'SESSION_EXPIRED', message: 'session expired' },
          });
          return;
        }
        const user = await deps.users.findById(row.userId);
        if (!user || user.isDisabled) {
          res.status(401).json({
            error: { code: 'USER_DISABLED', message: 'user disabled' },
          });
          return;
        }
        const membership = await deps.orgUsers.findMembership(
          user.orgId,
          user.id,
        );
        req.auth = {
          userId: user.id,
          orgId: user.orgId,
          orgRole: membership?.role ?? 'None',
          isServerAdmin: user.isAdmin,
          authenticatedBy: 'session',
          sessionId: row.id,
        };
        // Best-effort markSeen — never 500 on a transient write failure,
        // BUT log at warn level (not debug) so a failing markSeen surfaces in
        // standard log streams. A silently un-touched session is a real UX
        // bug: idle expiry ticks down even while the user is active.
        deps.sessions.markSeen(row.id).catch((err) => {
          log.warn(
            {
              err: err instanceof Error ? err.message : err,
              errClass: err instanceof Error ? err.constructor.name : typeof err,
              sessionId: row.id,
              metric: 'session.markSeen.failed',
            },
            'markSeen failed — session idle timer will not be refreshed',
          );
        });
        next();
        return;
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : err },
          'session lookup failed',
        );
        res.status(500).json({
          error: { code: 'INTERNAL_ERROR', message: 'internal auth error' },
        });
        return;
      }
    }

    // 2. Bearer / API-key.
    const token = bearerToken(req);
    if (token) {
      try {
        // Preferred path: T6.3 ApiKeyService — runs SA / PAT validation,
        // checks principal.is_disabled, and emits rate-limited `apikey.used`.
        if (deps.apiKeyService) {
          const lookup = await deps.apiKeyService.validateAndLookup(token);
          if (!lookup) {
            res.status(401).json({
              error: { code: 'INVALID_API_KEY', message: 'invalid api key' },
            });
            return;
          }
          req.auth = {
            userId: lookup.user.id,
            orgId: lookup.orgId,
            orgRole: lookup.role,
            isServerAdmin: lookup.isServerAdmin,
            authenticatedBy: 'api_key',
            serviceAccountId: lookup.serviceAccountId ?? undefined,
            sessionId: undefined,
          };
          next();
          return;
        }

        // Fallback: direct-repo lookup for pre-T6 test harnesses.
        const hashed = hashApiKey(token);
        const row = await deps.apiKeys.findByHashedKey(hashed);
        if (!row) {
          res.status(401).json({
            error: { code: 'INVALID_API_KEY', message: 'invalid api key' },
          });
          return;
        }
        if (row.expires && Date.parse(row.expires) < Date.now()) {
          res.status(401).json({
            error: { code: 'API_KEY_EXPIRED', message: 'api key expired' },
          });
          return;
        }
        deps.apiKeys
          .touchLastUsed(row.id, new Date().toISOString())
          .catch((err) => {
            log.debug(
              { err: err instanceof Error ? err.message : err },
              'touchLastUsed failed',
            );
          });
        const principalId = row.serviceAccountId ?? row.ownerUserId ?? '';
        let orgRole: Identity['orgRole'] = 'None';
        let isServerAdmin = false;
        if (principalId) {
          const principal = await deps.users.findById(principalId);
          if (!principal || principal.isDisabled) {
            res.status(401).json({
              error: { code: 'USER_DISABLED', message: 'principal disabled' },
            });
            return;
          }
          isServerAdmin = principal.isAdmin;
        }
        if (principalId) {
          const membership = await deps.orgUsers.findMembership(
            row.orgId,
            principalId,
          );
          if (membership) orgRole = membership.role;
        }
        req.auth = {
          userId: principalId,
          orgId: row.orgId,
          orgRole,
          isServerAdmin,
          authenticatedBy: 'api_key',
          serviceAccountId: row.serviceAccountId ?? undefined,
        };
        next();
        return;
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : err },
          'api key lookup failed',
        );
        res.status(500).json({
          error: { code: 'INTERNAL_ERROR', message: 'internal auth error' },
        });
        return;
      }
    }

    res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'authentication required' },
    });
  };
}
