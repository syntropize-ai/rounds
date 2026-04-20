/**
 * /api/user/* — current-user endpoints.
 *
 * Per docs/auth-perm-design/08-api-surface.md. All endpoints require
 * authentication.
 *
 * /api/user/permissions is intentionally NOT implemented here — T3 owns it.
 * See the comment at that registration site.
 */

import { Router, type Response } from 'express';
import type {
  IOrgUserRepository,
  IPreferencesRepository,
  IUserAuthRepository,
  IUserRepository,
} from '@agentic-obs/common';
import { AuditAction } from '@agentic-obs/common';
import type { AuditWriter } from '../auth/audit-writer.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import type { SessionService } from '../auth/session-service.js';
import {
  hashPassword,
  passwordMinLength,
  verifyPassword,
} from '../auth/local-provider.js';

export interface UserRouterDeps {
  users: IUserRepository;
  userAuth: IUserAuthRepository;
  orgUsers: IOrgUserRepository;
  sessions: SessionService;
  preferences?: IPreferencesRepository;
  audit: AuditWriter;
}

function requireAuth(req: AuthenticatedRequest, res: Response): boolean {
  if (!req.auth) {
    res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'authentication required' },
    });
    return false;
  }
  return true;
}

export function createUserRouter(deps: UserRouterDeps): Router {
  const router = Router();

  // GET /api/user — current user profile + org memberships.
  router.get('/', async (req: AuthenticatedRequest, res: Response) => {
    if (!requireAuth(req, res)) return;
    const user = await deps.users.findById(req.auth!.userId);
    if (!user) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'user not found' },
      });
      return;
    }
    const memberships = await deps.orgUsers.listOrgsByUserWithName(user.id);
    const auths = await deps.userAuth.listByUser(user.id);
    // `name` is required by the OrgSwitcher dropdown. The JOIN adds one
    // bounded lookup per session (users rarely belong to many orgs) and
    // saves N per-org round-trips on the frontend.
    const orgs = memberships.map((m) => ({
      orgId: m.orgId,
      name: m.orgName,
      role: m.role,
    }));
    res.json({
      id: user.id,
      email: user.email,
      login: user.login,
      name: user.name,
      theme: user.theme ?? '',
      orgId: user.orgId,
      isGrafanaAdmin: user.isAdmin,
      isDisabled: user.isDisabled,
      isExternal: auths.length > 0,
      authLabels: auths.map((a) => a.authModule),
      orgs,
    });
  });

  // PUT /api/user — update name/email/login.
  router.put('/', async (req: AuthenticatedRequest, res: Response) => {
    if (!requireAuth(req, res)) return;
    const body = (req.body ?? {}) as {
      name?: string;
      email?: string;
      login?: string;
    };
    const updated = await deps.users.update(req.auth!.userId, {
      name: body.name,
      email: body.email,
      login: body.login,
    });
    if (!updated) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'user not found' },
      });
      return;
    }
    void deps.audit.log({
      action: AuditAction.UserUpdated,
      actorType: 'user',
      actorId: req.auth!.userId,
      targetType: 'user',
      targetId: updated.id,
      targetName: updated.login,
      outcome: 'success',
    });
    res.json({ message: 'user updated' });
  });

  // PUT /api/user/password
  router.put(
    '/password',
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireAuth(req, res)) return;
      const body = (req.body ?? {}) as {
        oldPassword?: string;
        newPassword?: string;
      };
      if (!body.oldPassword || !body.newPassword) {
        res.status(400).json({
          error: {
            code: 'VALIDATION',
            message: 'oldPassword and newPassword are required',
          },
        });
        return;
      }
      if (body.newPassword.length < passwordMinLength()) {
        res.status(400).json({
          error: {
            code: 'VALIDATION',
            message: `password must be at least ${passwordMinLength()} characters`,
          },
        });
        return;
      }
      const user = await deps.users.findById(req.auth!.userId);
      if (!user || !user.password) {
        res.status(400).json({
          error: {
            code: 'NO_LOCAL_PASSWORD',
            message: 'user has no local password set',
          },
        });
        return;
      }
      const valid = await verifyPassword(body.oldPassword, user.password);
      if (!valid) {
        res.status(401).json({
          error: {
            code: 'INVALID_CREDENTIALS',
            message: 'invalid username or password',
          },
        });
        return;
      }
      const newHash = await hashPassword(body.newPassword);
      await deps.users.update(user.id, { password: newHash });
      await deps.sessions.revokeAllForUser(user.id);
      void deps.audit.log({
        action: AuditAction.UserPasswordChanged,
        actorType: 'user',
        actorId: user.id,
        outcome: 'success',
      });
      res.json({ message: 'password changed' });
    },
  );

  // GET/PUT /api/user/preferences
  router.get(
    '/preferences',
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireAuth(req, res)) return;
      if (!deps.preferences) {
        res.json({});
        return;
      }
      const prefs = await deps.preferences.findUserPrefs(
        req.auth!.orgId,
        req.auth!.userId,
      );
      res.json({
        homeDashboardUid: prefs?.homeDashboardUid ?? null,
        timezone: prefs?.timezone ?? '',
        theme: prefs?.theme ?? '',
        weekStart: prefs?.weekStart ?? '',
        locale: prefs?.locale ?? '',
      });
    },
  );

  router.put(
    '/preferences',
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireAuth(req, res)) return;
      if (!deps.preferences) {
        res.status(501).json({
          error: {
            code: 'NOT_IMPLEMENTED',
            message: 'preferences not configured',
          },
        });
        return;
      }
      const body = (req.body ?? {}) as {
        homeDashboardUid?: string;
        timezone?: string;
        theme?: string;
        weekStart?: string;
        locale?: string;
      };
      await deps.preferences.upsert({
        orgId: req.auth!.orgId,
        userId: req.auth!.userId,
        homeDashboardUid: body.homeDashboardUid ?? null,
        timezone: body.timezone ?? null,
        theme: body.theme ?? null,
        weekStart: body.weekStart ?? null,
        locale: body.locale ?? null,
      });
      res.json({ message: 'preferences updated' });
    },
  );

  // GET /api/user/auth-tokens — external logins (OAuth/SAML/LDAP linkages).
  router.get(
    '/auth-tokens',
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireAuth(req, res)) return;
      const auths = await deps.userAuth.listByUser(req.auth!.userId);
      res.json(
        auths.map((a) => ({
          id: a.id,
          authModule: a.authModule,
          authId: a.authId,
          created: a.created,
        })),
      );
    },
  );

  router.delete(
    '/auth-tokens/:id',
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireAuth(req, res)) return;
      const id = req.params['id'] ?? '';
      const row = await deps.userAuth.findById(id);
      if (!row || row.userId !== req.auth!.userId) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'auth token not found' },
        });
        return;
      }
      await deps.userAuth.delete(id);
      void deps.audit.log({
        action: AuditAction.UserAuthUnlinked,
        actorType: 'user',
        actorId: req.auth!.userId,
        targetType: 'user_auth',
        targetId: id,
        outcome: 'success',
        metadata: { module: row.authModule },
      });
      res.status(204).send();
    },
  );

  // GET /api/user/tokens — cookie sessions.
  router.get('/tokens', async (req: AuthenticatedRequest, res: Response) => {
    if (!requireAuth(req, res)) return;
    const rows = await deps.sessions.listForUser(req.auth!.userId);
    res.json(
      rows.map((r) => ({
        id: r.id,
        clientIp: r.clientIp,
        userAgent: r.userAgent,
        seenAt: r.seenAt,
        rotatedAt: r.rotatedAt,
        createdAt: r.createdAt,
        isActive: r.id === req.auth!.sessionId,
      })),
    );
  });

  // POST /api/user/revoke-auth-token.
  router.post(
    '/revoke-auth-token',
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireAuth(req, res)) return;
      const body = (req.body ?? {}) as { authTokenId?: string };
      if (!body.authTokenId) {
        res.status(400).json({
          error: { code: 'VALIDATION', message: 'authTokenId is required' },
        });
        return;
      }
      await deps.sessions.revoke(body.authTokenId);
      void deps.audit.log({
        action: AuditAction.SessionRevoked,
        actorType: 'user',
        actorId: req.auth!.userId,
        targetType: 'session',
        targetId: body.authTokenId,
        outcome: 'success',
      });
      res.json({ message: 'session revoked' });
    },
  );

  // POST /api/user/using/:orgId — switch default org.
  router.post(
    '/using/:orgId',
    async (req: AuthenticatedRequest, res: Response) => {
      if (!requireAuth(req, res)) return;
      const newOrgId = req.params['orgId'] ?? '';
      const membership = await deps.orgUsers.findMembership(
        newOrgId,
        req.auth!.userId,
      );
      if (!membership) {
        res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'not a member of that org' },
        });
        return;
      }
      await deps.users.update(req.auth!.userId, { orgId: newOrgId });
      res.json({ message: 'active organization changed' });
    },
  );

  return router;
}
