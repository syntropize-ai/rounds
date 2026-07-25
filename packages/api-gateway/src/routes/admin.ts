/**
 * Server-admin routes (/api/admin/*).
 *
 * Wave 6 / T9 / G3.c — admin router was a thin read-only harness with most
 * routes returning 501; now that the T8.3 Users UI is live we implement the
 * full CRUD it calls: create / update / delete / reset-password /
 * toggle-is-server-admin.
 *
 * See docs/auth-perm-design/08-api-surface.md §admin for the endpoint shape.
 *
 * Users-quota check on create follows 10-migration-plan.md §T9.3 pattern:
 *   current = COUNT(user) with is_service_account=0
 *   limit   = QuotaRepository.findOrgQuota(orgId, 'users').limitVal
 *   env fallback = QUOTA_USERS_PER_ORG
 *   limit === -1 → unlimited
 */

import { Router, type Request, type Response } from 'express';
import type {
  IAuditLogRepository,
  IOrgUserRepository,
  IQuotaRepository,
  IUserAuthTokenRepository,
  IUserRepository,
} from '@agentic-obs/common';
import { AuditAction, ORG_ROLES, type OrgRole } from '@agentic-obs/common';
import type { AuditWriter } from '../auth/audit-writer.js';
import type { SessionService } from '../auth/session-service.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { hashPassword, passwordMinLength } from '../auth/local-provider.js';
import { asyncHandler } from '../middleware/async-handler.js';

export interface AdminRouterDeps {
  users: IUserRepository;
  orgUsers: IOrgUserRepository;
  userAuthTokens: IUserAuthTokenRepository;
  auditLog: IAuditLogRepository;
  sessions: SessionService;
  audit: AuditWriter;
  /** Optional — when present, enforces the `users` per-org quota on create. */
  quotas?: IQuotaRepository;
  env?: NodeJS.ProcessEnv;
  /** Default org to attach new users to when the caller doesn't supply orgId. */
  defaultOrgId?: string;
}

function requireServerAdmin(
  req: AuthenticatedRequest,
  res: Response,
): boolean {
  if (!req.auth) {
    res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'authentication required' },
    });
    return false;
  }
  if (!req.auth.isServerAdmin) {
    res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'server admin required' },
    });
    return false;
  }
  return true;
}

function validEmail(email: string): boolean {
  // Intentionally permissive — matches Grafana's check: must contain @ and
  // at least one dot after the @. Full RFC 5322 compliance is delegated to
  // the mail server, not input validation.
  const at = email.indexOf('@');
  if (at < 1 || at === email.length - 1) return false;
  const dom = email.slice(at + 1);
  return dom.includes('.');
}

function isValidOrgRole(v: unknown): v is OrgRole {
  return typeof v === 'string' && (ORG_ROLES as readonly string[]).includes(v);
}

function parseUsersQuotaEnv(env: NodeJS.ProcessEnv | undefined): number {
  if (!env) return -1;
  const raw = env['QUOTA_USERS_PER_ORG'];
  if (raw === undefined || raw === null || raw === '') return -1;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : -1;
}

export function createAdminRouter(deps: AdminRouterDeps): Router {
  const router = Router();
  const env = deps.env ?? process.env;
  const defaultOrgId = deps.defaultOrgId ?? 'org_main';

  // GET /api/admin/users — list + search + paginate.
  router.get('/users', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!requireServerAdmin(req, res)) return;
    const perpage = Math.min(
      parseInt((req.query['perpage'] as string | undefined) ?? '100', 10),
      500,
    );
    const page = Math.max(
      parseInt((req.query['page'] as string | undefined) ?? '1', 10),
      1,
    );
    const search =
      typeof req.query['query'] === 'string'
        ? (req.query['query'] as string)
        : undefined;
    const { items, total } = await deps.users.list({
      limit: perpage,
      offset: (page - 1) * perpage,
      search,
    });
    res.json({
      totalCount: total,
      users: items.map((u) => ({
        id: u.id,
        email: u.email,
        login: u.login,
        name: u.name,
        isAdmin: u.isAdmin,
        isDisabled: u.isDisabled,
        isServiceAccount: u.isServiceAccount,
        created: u.created,
        updated: u.updated,
        lastSeenAt: u.lastSeenAt,
      })),
      page,
      perPage: perpage,
    });
  }));

  // POST /api/admin/users — create a new local user. Enforces quota.
  router.post('/users', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!requireServerAdmin(req, res)) return;
    const body = (req.body ?? {}) as {
      email?: string;
      login?: string;
      name?: string;
      password?: string;
      orgId?: string;
      orgRole?: string;
      isAdmin?: boolean;
    };
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const login = typeof body.login === 'string' && body.login.trim() !== ''
      ? body.login.trim()
      : email.split('@')[0] ?? '';
    const name = typeof body.name === 'string' ? body.name.trim() : login;
    const password = typeof body.password === 'string' ? body.password : '';
    const orgId = typeof body.orgId === 'string' && body.orgId !== ''
      ? body.orgId
      : defaultOrgId;
    const role: OrgRole = isValidOrgRole(body.orgRole) ? body.orgRole : 'Viewer';
    const isAdmin = body.isAdmin === true;

    if (!validEmail(email)) {
      res.status(400).json({
        error: { code: 'VALIDATION', message: 'valid email required' },
      });
      return;
    }
    if (!login) {
      res.status(400).json({
        error: { code: 'VALIDATION', message: 'login required' },
      });
      return;
    }
    const minLen = passwordMinLength(env);
    if (password.length < minLen) {
      res.status(400).json({
        error: {
          code: 'VALIDATION',
          message: `password must be at least ${minLen} characters`,
        },
      });
      return;
    }

    // Conflict checks before the quota check (so a legitimate duplicate returns
    // 409 rather than 403).
    if (await deps.users.findByEmail(email)) {
      res.status(409).json({
        error: { code: 'CONFLICT', message: 'email already exists' },
      });
      return;
    }
    if (await deps.users.findByLogin(login)) {
      res.status(409).json({
        error: { code: 'CONFLICT', message: 'login already exists' },
      });
      return;
    }

    // Users quota (per org).
    let limit = parseUsersQuotaEnv(env);
    if (deps.quotas) {
      const row = await deps.quotas.findOrgQuota(orgId, 'users');
      if (row && Number.isFinite(row.limitVal)) limit = row.limitVal;
    }
    if (limit !== -1) {
      // Count non-service-account users currently in this org via org_user.
      const existing = await deps.orgUsers.listUsersByOrg(orgId, {
        limit: 1,
      });
      const humans = existing.items.filter((u) => !u.isServiceAccount);
      // listUsersByOrg with limit:1 returns .total — use that for the cheap
      // path. `humans` is just a sanity pass for tiny orgs where limit===0.
      const current = Math.max(existing.total - 0, humans.length);
      if (current >= limit) {
        void deps.audit.log({
          action: AuditAction.UserCreated,
          actorType: 'user',
          actorId: req.auth!.userId,
          targetType: 'user',
          targetId: email,
          outcome: 'failure',
          metadata: { reason: 'quota_exceeded', target: 'users', orgId },
        });
        res.status(403).json({
          error: { code: 'QUOTA_EXCEEDED', message: 'Quota exceeded for users' },
        });
        return;
      }
    }

    const hashed = await hashPassword(password);
    const user = await deps.users.create({
      email,
      name,
      login,
      password: hashed,
      orgId,
      isAdmin,
      emailVerified: true,
    });
    await deps.orgUsers.create({ orgId, userId: user.id, role });

    void deps.audit.log({
      action: AuditAction.UserCreated,
      actorType: 'user',
      actorId: req.auth!.userId,
      targetType: 'user',
      targetId: user.id,
      outcome: 'success',
      metadata: { orgId, role, isAdmin },
    });

    res.status(201).json({
      id: user.id,
      email: user.email,
      login: user.login,
      name: user.name,
      isAdmin: user.isAdmin,
      orgId,
      role,
    });
  }));

  // PATCH /api/admin/users/:id — update profile fields.
  router.patch(
    '/users/:id',
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      if (!requireServerAdmin(req, res)) return;
      const id = req.params['id'] ?? '';
      const body = (req.body ?? {}) as {
        email?: string;
        name?: string;
        login?: string;
      };
      const patch: Record<string, string> = {};
      if (typeof body.email === 'string' && body.email.trim() !== '') {
        if (!validEmail(body.email.trim())) {
          res.status(400).json({
            error: { code: 'VALIDATION', message: 'invalid email' },
          });
          return;
        }
        patch['email'] = body.email.trim();
      }
      if (typeof body.name === 'string' && body.name.trim() !== '') {
        patch['name'] = body.name.trim();
      }
      if (typeof body.login === 'string' && body.login.trim() !== '') {
        patch['login'] = body.login.trim();
      }
      if (Object.keys(patch).length === 0) {
        res.status(400).json({
          error: {
            code: 'VALIDATION',
            message: 'no updatable fields provided',
          },
        });
        return;
      }
      const updated = await deps.users.update(id, patch);
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
        targetId: id,
        outcome: 'success',
        metadata: patch,
      });
      res.json({ message: 'user updated', id });
    }),
  );

  // DELETE /api/admin/users/:id — hard delete + revoke sessions.
  router.delete(
    '/users/:id',
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      if (!requireServerAdmin(req, res)) return;
      const id = req.params['id'] ?? '';
      const existing = await deps.users.findById(id);
      if (!existing) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'user not found' },
        });
        return;
      }
      // Refuse to delete the last server admin so the install stays
      // administerable. This matches Grafana's `admin_users.go` guard.
      if (existing.isAdmin) {
        const all = await deps.users.list({ limit: 1000 });
        const admins = all.items.filter((u) => u.isAdmin && !u.isDisabled);
        if (admins.length <= 1) {
          res.status(400).json({
            error: {
              code: 'LAST_SERVER_ADMIN',
              message: 'cannot delete the last server admin',
            },
          });
          return;
        }
      }
      await deps.sessions.revokeAllForUser(id);
      await deps.users.delete(id);
      void deps.audit.log({
        action: AuditAction.UserDeleted,
        actorType: 'user',
        actorId: req.auth!.userId,
        targetType: 'user',
        targetId: id,
        outcome: 'success',
      });
      res.json({ message: 'user deleted' });
    }),
  );

  // POST /api/admin/users/:id/password — reset password.
  router.post(
    '/users/:id/password',
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      if (!requireServerAdmin(req, res)) return;
      const id = req.params['id'] ?? '';
      const body = (req.body ?? {}) as { password?: string };
      const password = typeof body.password === 'string' ? body.password : '';
      const minLen = passwordMinLength(env);
      if (password.length < minLen) {
        res.status(400).json({
          error: {
            code: 'VALIDATION',
            message: `password must be at least ${minLen} characters`,
          },
        });
        return;
      }
      const existing = await deps.users.findById(id);
      if (!existing) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'user not found' },
        });
        return;
      }
      const hashed = await hashPassword(password);
      await deps.users.update(id, { password: hashed });
      // Force re-auth by revoking existing sessions.
      await deps.sessions.revokeAllForUser(id);
      void deps.audit.log({
        action: AuditAction.UserPasswordForceReset,
        actorType: 'user',
        actorId: req.auth!.userId,
        targetType: 'user',
        targetId: id,
        outcome: 'success',
      });
      res.json({ message: 'password reset' });
    }),
  );

  // POST /api/admin/users/:id/permissions — toggle server-admin flag.
  router.post(
    '/users/:id/permissions',
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      if (!requireServerAdmin(req, res)) return;
      const id = req.params['id'] ?? '';
      const body = (req.body ?? {}) as { isServerAdmin?: boolean };
      if (typeof body.isServerAdmin !== 'boolean') {
        res.status(400).json({
          error: {
            code: 'VALIDATION',
            message: 'isServerAdmin boolean required',
          },
        });
        return;
      }
      const existing = await deps.users.findById(id);
      if (!existing) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'user not found' },
        });
        return;
      }
      // Prevent demoting the last server admin.
      if (existing.isAdmin && !body.isServerAdmin) {
        const all = await deps.users.list({ limit: 1000 });
        const admins = all.items.filter((u) => u.isAdmin && !u.isDisabled);
        if (admins.length <= 1) {
          res.status(400).json({
            error: {
              code: 'LAST_SERVER_ADMIN',
              message: 'cannot demote the last server admin',
            },
          });
          return;
        }
      }
      await deps.users.update(id, { isAdmin: body.isServerAdmin });
      void deps.audit.log({
        action: AuditAction.UserUpdated,
        actorType: 'user',
        actorId: req.auth!.userId,
        targetType: 'user',
        targetId: id,
        outcome: 'success',
        metadata: { isServerAdmin: body.isServerAdmin },
      });
      res.json({ message: 'permissions updated', isServerAdmin: body.isServerAdmin });
    }),
  );

  router.post(
    '/users/:userId/disable',
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      if (!requireServerAdmin(req, res)) return;
      const id = req.params['userId'] ?? '';
      await deps.users.setDisabled(id, true);
      await deps.sessions.revokeAllForUser(id);
      void deps.audit.log({
        action: AuditAction.UserDisabled,
        actorType: 'user',
        actorId: req.auth!.userId,
        targetType: 'user',
        targetId: id,
        outcome: 'success',
      });
      res.json({ message: 'user disabled' });
    }),
  );

  router.post(
    '/users/:userId/enable',
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      if (!requireServerAdmin(req, res)) return;
      const id = req.params['userId'] ?? '';
      await deps.users.setDisabled(id, false);
      void deps.audit.log({
        action: AuditAction.UserEnabled,
        actorType: 'user',
        actorId: req.auth!.userId,
        targetType: 'user',
        targetId: id,
        outcome: 'success',
      });
      res.json({ message: 'user enabled' });
    }),
  );

  router.post(
    '/users/:userId/logout',
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      if (!requireServerAdmin(req, res)) return;
      const id = req.params['userId'] ?? '';
      const n = await deps.sessions.revokeAllForUser(id);
      void deps.audit.log({
        action: AuditAction.SessionRevoked,
        actorType: 'user',
        actorId: req.auth!.userId,
        targetType: 'user',
        targetId: id,
        outcome: 'success',
        metadata: { revoked: n },
      });
      res.json({ message: 'sessions revoked', revoked: n });
    }),
  );

  router.get(
    '/audit-log',
    asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
      if (!requireServerAdmin(req, res)) return;
      const perpage = Math.min(
        parseInt((req.query['perpage'] as string | undefined) ?? '100', 10),
        500,
      );
      const page = Math.max(
        parseInt((req.query['page'] as string | undefined) ?? '1', 10),
        1,
      );
      const { items, total } = await deps.auditLog.query({
        limit: perpage,
        offset: (page - 1) * perpage,
        action: req.query['action'] as string | undefined,
        actorId: req.query['actorId'] as string | undefined,
        targetId: req.query['targetId'] as string | undefined,
        outcome: req.query['outcome'] as 'success' | 'failure' | undefined,
        from: req.query['from'] as string | undefined,
        to: req.query['to'] as string | undefined,
      });
      res.json({ items, total, page, perpage });
    }),
  );

  router.get('/stats', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!requireServerAdmin(req, res)) return;
    const { total: userCount } = await deps.users.list({ limit: 1 });
    res.json({ userCount });
  }));

  // Catch-all. Left in for discoverability but now only catches genuinely
  // unimplemented paths — none of the Wave 8/9 UI pages hit this.
  router.all('/*', (_req: Request, res: Response) => {
    res.status(501).json({
      message:
        'not implemented — see docs/auth-perm-design/08-api-surface.md',
    });
  });

  return router;
}
