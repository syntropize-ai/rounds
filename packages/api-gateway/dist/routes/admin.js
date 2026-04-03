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
const VALID_ROLES = new Set(['admin', 'operator', 'investigator', 'viewer', 'readonly']);
export function createAdminRouter() {
    const router = Router();
    // All admin routes require authentication + admin-level (*) permission
    router.use(authMiddleware);
    router.use(requirePermission('*:*'));
    // -- Users
    router.get('/users', (_req, res) => {
        res.json({ users: userStore.list().map(sanitizeUser) });
    });
    router.post('/users', async (req, res) => {
        const body = req.body;
        const email = body['email'];
        const name = body['name'];
        const role = body['role'];
        const password = body['password'];
        if (!email || !name) {
            res.status(400).json({ code: 'VALIDATION', message: 'email and name are required' });
            return;
        }
        if (role !== undefined && !VALID_ROLES.has(role)) {
            res.status(400).json({ code: 'VALIDATION', message: `Invalid role. Must be one of: ${[...VALID_ROLES].join(', ')}` });
            return;
        }
        if (userStore.findByEmail?.(email)) {
            res.status(409).json({ code: 'CONFLICT', message: 'A user with this email already exists' });
            return;
        }
        try {
            const safeEmail = email;
            const safeName = name;
            const tempPassword = password ?? crypto.randomBytes(12).toString('base64url');
            const user = await createLocalUser(safeEmail, tempPassword, safeName, role ?? 'viewer');
            userStore.addAuditEntry({
                action: 'user_created',
                actorId: req.auth?.sub,
                targetId: user.id,
                targetEmail: user.email,
            });
            res.status(201).json({ user: sanitizeUser(user) });
        }
        catch (err) {
            res.status(500).json({ code: 'INTERNAL', message: err instanceof Error ? err.message : 'Failed to create user' });
        }
    });
    router.patch('/users/:id', (req, res) => {
        const id = req.params['id'] ?? '';
        const body = req.body;
        const role = body['role'];
        const name = body['name'];
        const disabled = body['disabled'];
        if (role !== undefined && !VALID_ROLES.has(role)) {
            res.status(400).json({ code: 'VALIDATION', message: `Invalid role. Must be one of: ${[...VALID_ROLES].join(', ')}` });
            return;
        }
        const updates = {};
        if (role !== undefined)
            updates.role = role;
        if (name !== undefined)
            updates.name = name;
        if (disabled !== undefined)
            updates.disabled = disabled;
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
                targetEmail: updated.email,
                details: { newRole: role },
            });
        }
        else {
            userStore.addAuditEntry({
                action: 'user_updated',
                actorId: actorId ?? undefined,
                targetId: id,
                targetEmail: updated.email,
            });
        }
        // Revoke existing sessions when disabling or role changes (force re-login)
        if (disabled || role !== undefined)
            sessionStore.revokeAllForUser?.(id);
        res.json({ user: sanitizeUser(updated) });
    });
    router.delete('/users/:id', (req, res) => {
        const id = req.params['id'] ?? '';
        const actorId = req.auth?.sub;
        if (actorId !== undefined && actorId === id) {
            res.status(400).json({ code: 'VALIDATION', message: 'Cannot delete your own account' });
            return;
        }
        const user = userStore.findById(id);
        if (!user) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'User not found' });
            return;
        }
        sessionStore.revokeAllForUser?.(id);
        userStore.delete(id);
        userStore.addAuditEntry({
            action: 'user_deleted',
            actorId: actorId ?? undefined,
            targetId: id,
            targetEmail: user.email,
        });
        res.json({ ok: true });
    });
    // -- Teams
    router.get('/teams', (_req, res) => {
        res.json({ teams: userStore.listTeams() });
    });
    router.post('/teams', (req, res) => {
        const body = req.body;
        const name = body['name'];
        const permissions = body['permissions'];
        if (!name) {
            res.status(400).json({ code: 'VALIDATION', message: 'name is required' });
            return;
        }
        const team = userStore.createTeam({ name, permissions: permissions ?? [], members: [] });
        const actorId = req.auth?.sub;
        userStore.addAuditEntry({ action: 'team_created', actorId: actorId ?? undefined, targetId: team.id });
        res.status(201).json(team);
    });
    router.patch('/teams/:id', (req, res) => {
        const id = req.params['id'] ?? '';
        const body = req.body;
        const name = body['name'];
        const permissions = body['permissions'];
        const updates = {};
        if (name !== undefined)
            updates.name = name;
        if (permissions !== undefined)
            updates.permissions = permissions;
        const updated = userStore.updateTeam(id, updates);
        if (!updated) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Team not found' });
            return;
        }
        const actorId = req.auth?.sub;
        userStore.addAuditEntry({ action: 'team_updated', actorId: actorId ?? undefined, targetId: id });
        res.json(updated);
    });
    router.delete('/teams/:id', (req, res) => {
        const id = req.params['id'] ?? '';
        if (!userStore.findTeamById(id)) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Team not found' });
            return;
        }
        const actorId = req.auth?.sub;
        userStore.deleteTeam(id);
        userStore.addAuditEntry({ action: 'team_deleted', actorId: actorId ?? undefined, targetId: id });
        res.json({ ok: true });
    });
    router.post('/teams/:id/members', (req, res) => {
        const id = req.params['id'] ?? '';
        const body = req.body;
        const userId = body['userId'];
        const role = body['role'] ?? 'member';
        if (!userId) {
            res.status(400).json({ code: 'VALIDATION', message: 'userId is required' });
            return;
        }
        const team = userStore.findTeamById(id);
        if (!team) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Team not found' });
            return;
        }
        const safeUserId = String(userId);
        if (!userStore.findById(safeUserId)) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'User not found' });
            return;
        }
        const members = [...team.members];
        const existing = members.findIndex((m) => m.userId === safeUserId);
        if (existing >= 0)
            members[existing] = { userId: safeUserId, role };
        else
            members.push({ userId: safeUserId, role });
        const updated = userStore.updateTeam(id, { members });
        const current = userStore.findById(safeUserId);
        if (current && !current.teams.includes(id))
            userStore.update(safeUserId, { teams: [...current.teams, id] });
        res.json({ team: updated });
    });
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
        if (user)
            userStore.update(userId, { teams: user.teams.filter((t) => t !== id) });
        res.json({ ok: true });
    });
    // -- Audit Log
    router.get('/audit-log', (req, res) => {
        const limit = Math.min(parseInt(req.query['limit'] ?? '100', 10), 500);
        const offset = parseInt(req.query['offset'] ?? '0', 10);
        const result = userStore.getAuditLog(limit, offset);
        res.json(result);
    });
    return router;
}
//# sourceMappingURL=admin.js.map