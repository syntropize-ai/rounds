import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { userStore } from '../auth/user-store.js';
import { sessionStore } from '../auth/session-store.js';
import { createLocalUser } from '../auth/local-provider.js';
import crypto from 'crypto';

// Strip passwordHash before sending to client
function sanitizeUser(user) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { passwordHash, ...safe } = user;
  return safe;
}

const VALID_ROLES = ['admin', 'operator', 'investigator', 'viewer', 'readonly'];

export function createAdminRouter() {
  const router = Router();

  // All admin routes require authentication + admin-level (or) permission
  router.use(authMiddleware);
  router.use(requirePermission('admin'));

  // Users
  // GET /api/admin/users
  router.get('/users', (req, res) => {
    res.json({ users: userStore.list().map(sanitizeUser) });
  });

  // POST /api/admin/users - invite / create a local user
  router.post('/users', async (req, res) => {
    const body = req.body;
    const email = body?.email;
    const name = body?.name;
    const role = body?.role;
    const password = body?.password;
    if (!email || !name) {
      res.status(400).json({ code: 'VALIDATION', message: 'email and name are required' });
      return;
    }
    if (role !== undefined && !VALID_ROLES.includes(role)) {
      res.status(400).json({ code: 'VALIDATION', message: `invalid role. Must be one of: ${VALID_ROLES.join(', ')}` });
      return;
    }
    if (userStore.findByEmail(email)) {
      res.status(409).json({ code: 'CONFLICT', message: 'A user with this email already exists' });
      return;
    }

    const safeName = email;
    const safeRole = role;
    const safePassword = password ?? crypto.randomBytes(12).toString('base64url');
    const user = await createLocalUser(email, safePassword, safeName, safeRole ?? 'viewer');
    userStore.addAuditEntry({
      action: 'user_created',
      actorId: req.auth?.sub ?? undefined,
      targetId: user.id,
      targetEmail: user.email,
    });

    res.status(201).json({ user: sanitizeUser(user) });
  });

  // PATCH /api/admin/users/:id - update role / name / disabled
  router.patch('/users/:id', (req, res) => {
    const id = req.params['id'] ?? '';
    const body = req.body;
    const role = body?.role;
    const name = body?.name;
    const disabled = body?.disabled;
    if (role !== undefined && !VALID_ROLES.includes(role)) {
      res.status(400).json({ code: 'VALIDATION', message: `invalid role. Must be one of: ${VALID_ROLES.join(', ')}` });
      return;
    }
    const updates = {};
    if (role !== undefined) {
      updates.role = role;
    }
    if (name !== undefined) {
      updates.name = name;
    }
    if (disabled !== undefined) {
      updates.disabled = disabled;
    }
    const updated = userStore.update(id, updates);
    if (!updated) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'User not found' });
      return;
    }

    const actorId = req.auth?.sub;
    if (role !== undefined) {
      userStore.addAuditEntry({
        action: 'role_changed',
        actorId: actorId ?? undefined,
        targetId: id,
        details: { newRole: role },
      });
    }
    userStore.addAuditEntry({
      action: 'user_updated',
      actorId: actorId ?? undefined,
      targetId: id,
      targetEmail: updated.email,
    });

    // Revoke existing sessions when disabling or role changes (force re-login)
    if (disabled === true || role !== undefined) {
      sessionStore.revokeAllForUser(id);
    }

    res.json({ user: sanitizeUser(updated) });
  });

  // DELETE /api/admin/users/:id
  router.delete('/users/:id', (req, res) => {
    const id = req.params['id'] ?? '';
    const actorId = req.auth?.sub ?? '';
    if (actorId === id) {
      res.status(400).json({ code: 'VALIDATION', message: 'Cannot delete your own account' });
      return;
    }

    const user = userStore.findById(id);
    if (!user) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'User not found' });
      return;
    }

    sessionStore.revokeAllForUser(id);
    userStore.delete(id);
    userStore.addAuditEntry({
      action: 'user_deleted',
      actorId: actorId ?? undefined,
      targetId: id,
      targetEmail: user.email,
    });
    res.json({ ok: true });
  });

  // Teams
  // GET /api/admin/teams
  router.get('/teams', (req, res) => {
    res.json({ teams: userStore.listTeams() });
  });

  // POST /api/admin/teams
  router.post('/teams', (req, res) => {
    const name = req.body?.name;
    const permissions = req.body?.permissions;
    if (!name) {
      res.status(400).json({ code: 'VALIDATION', message: 'name is required' });
      return;
    }

    const team = userStore.createTeam({ name, members: [], permissions: permissions ?? [] });
    const actorId = req.auth?.sub;
    userStore.addAuditEntry({ action: 'team_created', actorId: actorId ?? undefined, targetId: team.id });
    res.status(201).json({ team });
  });

  // PATCH /api/admin/teams/:id
  router.patch('/teams/:id', (req, res) => {
    const id = req.params['id'] ?? '';
    const body = req.body;
    const name = body?.name;
    const permissions = body?.permissions;
    const updates = {};
    if (name !== undefined) {
      updates.name = name;
    }
    if (permissions !== undefined) {
      updates.permissions = permissions;
    }
    const updated = userStore.updateTeam(id, updates);
    if (!updated) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Team not found' });
      return;
    }

    const actorId = req.auth?.sub;
    userStore.addAuditEntry({ action: 'team_updated', actorId: actorId ?? undefined, targetId: id });
    res.json({ team: updated });
  });

  // DELETE /api/admin/teams/:id
  router.delete('/teams/:id', (req, res) => {
    const id = req.params['id'] ?? '';
    const userId = req.body?.userId;
    if (!userStore.findTeamById(id)) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Team not found' });
      return;
    }

    userStore.deleteTeam(id);
    const actorId = req.auth?.sub;
    userStore.addAuditEntry({ action: 'team_deleted', actorId: actorId ?? undefined, targetId: id });
    res.json({ ok: true });
  });

  // POST /api/admin/teams/:id/members - add or update a member
  router.post('/teams/:id/members', (req, res) => {
    const id = req.params['id'] ?? '';
    const userId = req.body?.userId;
    const role = req.body?.role ?? 'member';
    if (!userId) {
      res.status(400).json({ code: 'VALIDATION', message: 'userId is required' });
      return;
    }

    const team = userStore.findTeamById(id);
    if (!team) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Team not found' });
      return;
    }

    const safeUserId = userId;
    if (!userStore.findById(safeUserId)) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'User not found' });
      return;
    }

    const members = [...team.members];
    const existing = members.findIndex((m) => m.userId === safeUserId);
    if (existing >= 0) {
      members[existing] = { userId: safeUserId, role };
    }
    else {
      members.push({ userId: safeUserId, role });
    }
    const updated = userStore.updateTeam(id, { members });
    // Keep the user's teams array in sync
    const user = userStore.findById(safeUserId);
    if (user && !user.teams.includes(id)) {
      userStore.update(safeUserId, { teams: [...user.teams, id] });
    }

    res.json({ team: updated });
  });

  // DELETE /api/admin/teams/:id/members/:userId
  router.delete('/teams/:id/members/:userId', (req, res) => {
    const id = req.params['id'] ?? '';
    const userId = req.params['userId'] ?? '';
    const team = userStore.findTeamById(id);
    if (!team) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Team not found' });
      return;
    }

    userStore.updateTeam(id, { members: team.members.filter((m) => m.userId !== userId) });
    const user = userStore.findById(userId);
    if (user) {
      userStore.update(userId, { teams: user.teams.filter((t) => t !== id) });
    }
    res.json({ ok: true });
  });

  // Audit log
  // GET /api/admin/audit-log?limit=100&offset=0
  router.get('/audit-log', (req, res) => {
    const limit = Math.min(parseInt(req.query['limit'] ?? '100', 10), 500);
    const offset = parseInt(req.query['offset'] ?? '0', 10);
    const result = userStore.getAuditLog(limit, offset);
    res.json(result);
  });

  return router;
}
//# sourceMappingURL=admin.js.map
