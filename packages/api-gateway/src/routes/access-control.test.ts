import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  createTestDb,
  seedDefaultOrg,
  seedRbacForOrg,
  OrgUserRepository,
  TeamMemberRepository,
  RoleRepository,
  PermissionRepository,
  UserRoleRepository,
  TeamRoleRepository,
  UserRepository,
  TeamRepository,
} from '@agentic-obs/data-layer';
import type { SqliteClient } from '@agentic-obs/data-layer';
import type { Identity } from '@agentic-obs/common';
import { AccessControlService } from '../services/accesscontrol-service.js';
import { createAccessControlRouter } from './access-control.js';

interface Harness {
  db: SqliteClient;
  app: express.Express;
  identity: Identity;
  seedUser: (login: string) => Promise<string>;
  seedTeam: (name: string) => Promise<string>;
}

async function makeHarness(role: 'Viewer' | 'Editor' | 'Admin' | 'None' = 'Admin', isServerAdmin = false): Promise<Harness> {
  const db = createTestDb();
  await seedDefaultOrg(db);
  await seedRbacForOrg(db, 'org_main');

  const identity: Identity = {
    userId: 'u_admin',
    orgId: 'org_main',
    orgRole: role,
    isServerAdmin,
    authenticatedBy: 'session',
  };
  const ac = new AccessControlService({
    permissions: new PermissionRepository(db),
    roles: new RoleRepository(db),
    userRoles: new UserRoleRepository(db),
    teamRoles: new TeamRoleRepository(db),
    teamMembers: new TeamMemberRepository(db),
    orgUsers: new OrgUserRepository(db),
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { auth?: Identity }).auth = identity;
    next();
  });
  app.use(
    '/api/access-control',
    createAccessControlRouter({
      ac,
      roleRepo: new RoleRepository(db),
      permissionRepo: new PermissionRepository(db),
      userRoles: new UserRoleRepository(db),
      teamRoles: new TeamRoleRepository(db),
      db,
    }),
  );

  const userRepo = new UserRepository(db);
  const teamRepo = new TeamRepository(db);
  const seedUser = async (login: string): Promise<string> => {
    const existing = await userRepo.findByLogin(login);
    if (existing) return existing.id;
    const u = await userRepo.create({
      login,
      email: `${login}@test.local`,
      name: login,
      orgId: 'org_main',
    });
    return u.id;
  };
  const seedTeam = async (name: string): Promise<string> => {
    const existing = await teamRepo.findByName('org_main', name);
    if (existing) return existing.id;
    const t = await teamRepo.create({ orgId: 'org_main', name });
    return t.id;
  };

  return { db, app, identity, seedUser, seedTeam };
}

describe('/api/access-control routes', () => {
  describe('GET /roles', () => {
    it('returns the seeded role catalog as DTOs (admin)', async () => {
      const h = await makeHarness('Admin');
      const res = await request(h.app).get('/api/access-control/roles');
      expect(res.status).toBe(200);
      const names = (res.body as Array<{ name: string }>).map((r) => r.name);
      expect(names).toContain('basic:viewer');
      expect(names).toContain('fixed:dashboards:reader');
    });

    it('403 for a viewer lacking roles:read (N/A: viewer has no roles:read)', async () => {
      const h = await makeHarness('Viewer');
      const res = await request(h.app).get('/api/access-control/roles');
      expect(res.status).toBe(403);
      expect(res.body.error?.message).toMatch(/User has no permission to/);
    });
  });

  describe('POST /roles', () => {
    it('creates a custom role (admin)', async () => {
      const h = await makeHarness('Admin');
      const res = await request(h.app)
        .post('/api/access-control/roles')
        .send({
          name: 'custom:integration-test',
          displayName: 'Integration',
          permissions: [{ action: 'dashboards:read', scope: 'dashboards:*' }],
        });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('custom:integration-test');
      expect(res.body.permissions).toHaveLength(1);
    });

    it('400 on missing name', async () => {
      const h = await makeHarness('Admin');
      const res = await request(h.app)
        .post('/api/access-control/roles')
        .send({ permissions: [] });
      expect(res.status).toBe(400);
    });

    it('400 on reserved prefix', async () => {
      const h = await makeHarness('Admin');
      const res = await request(h.app)
        .post('/api/access-control/roles')
        .send({ name: 'basic:sneaky', permissions: [] });
      expect(res.status).toBe(400);
    });

    it('403 for viewer', async () => {
      const h = await makeHarness('Viewer');
      const res = await request(h.app)
        .post('/api/access-control/roles')
        .send({ name: 'custom:v', permissions: [] });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /roles/:roleUid', () => {
    it('returns a role by uid', async () => {
      const h = await makeHarness('Admin');
      const res = await request(h.app).get(
        '/api/access-control/roles/basic_viewer',
      );
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('basic:viewer');
    });

    it('404 for unknown uid', async () => {
      const h = await makeHarness('Admin');
      const res = await request(h.app).get(
        '/api/access-control/roles/unknown_uid',
      );
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /roles/:roleUid', () => {
    it('400 on built-in role', async () => {
      const h = await makeHarness('Admin');
      const res = await request(h.app)
        .put('/api/access-control/roles/basic_viewer')
        .send({ version: 0 });
      expect(res.status).toBe(400);
      expect(res.body.error?.message).toMatch(/read-only/);
    });

    it('updates a custom role', async () => {
      const h = await makeHarness('Admin');
      const create = await request(h.app)
        .post('/api/access-control/roles')
        .send({ name: 'custom:put-me', permissions: [] });
      const uid = create.body.uid;
      const version = create.body.version;
      const res = await request(h.app)
        .put(`/api/access-control/roles/${uid}`)
        .send({ version, displayName: 'Updated', permissions: [{ action: 'folders:read', scope: 'folders:*' }] });
      expect(res.status).toBe(200);
      expect(res.body.displayName).toBe('Updated');
      expect(res.body.permissions).toHaveLength(1);
    });

    it('409 on version mismatch', async () => {
      const h = await makeHarness('Admin');
      const create = await request(h.app)
        .post('/api/access-control/roles')
        .send({ name: 'custom:versioned', permissions: [] });
      const uid = create.body.uid;
      const res = await request(h.app)
        .put(`/api/access-control/roles/${uid}`)
        .send({ version: 999 });
      expect(res.status).toBe(409);
    });
  });

  describe('DELETE /roles/:roleUid', () => {
    it('204 on delete of custom role', async () => {
      const h = await makeHarness('Admin');
      const create = await request(h.app)
        .post('/api/access-control/roles')
        .send({ name: 'custom:del-me', permissions: [] });
      const res = await request(h.app).delete(
        `/api/access-control/roles/${create.body.uid}`,
      );
      expect(res.status).toBe(204);
    });

    it('400 on delete of built-in', async () => {
      const h = await makeHarness('Admin');
      const res = await request(h.app).delete(
        '/api/access-control/roles/basic_viewer',
      );
      expect(res.status).toBe(400);
    });
  });

  describe('user role assignments', () => {
    it('POST + DELETE /users/:userId/roles', async () => {
      const h = await makeHarness('Admin');
      const userId = await h.seedUser('u_abc');
      const role = await request(h.app)
        .post('/api/access-control/roles')
        .send({ name: 'custom:u-assign', permissions: [] });
      const postRes = await request(h.app)
        .post(`/api/access-control/users/${userId}/roles`)
        .send({ roleUid: role.body.uid });
      expect(postRes.status).toBe(204);

      const getRes = await request(h.app).get(
        `/api/access-control/users/${userId}/roles`,
      );
      expect(getRes.status).toBe(200);
      expect((getRes.body as Array<{ uid: string }>).map((r) => r.uid)).toContain(
        role.body.uid,
      );

      const delRes = await request(h.app).delete(
        `/api/access-control/users/${userId}/roles/${role.body.uid}`,
      );
      expect(delRes.status).toBe(204);
    });

    it('PUT /users/:userId/roles replaces the set', async () => {
      const h = await makeHarness('Admin');
      const userId = await h.seedUser('u_put');
      const r1 = await request(h.app)
        .post('/api/access-control/roles')
        .send({ name: 'custom:r1', permissions: [] });
      const r2 = await request(h.app)
        .post('/api/access-control/roles')
        .send({ name: 'custom:r2', permissions: [] });
      await request(h.app)
        .put(`/api/access-control/users/${userId}/roles`)
        .send({ roleUids: [r1.body.uid, r2.body.uid] });
      await request(h.app)
        .put(`/api/access-control/users/${userId}/roles`)
        .send({ roleUids: [r2.body.uid] });
      const after = await request(h.app).get(
        `/api/access-control/users/${userId}/roles`,
      );
      expect((after.body as Array<{ uid: string }>).map((r) => r.uid)).toEqual([
        r2.body.uid,
      ]);
    });
  });

  describe('team role assignments', () => {
    it('POST + DELETE /teams/:teamId/roles', async () => {
      const h = await makeHarness('Admin');
      const teamId = await h.seedTeam('team_xyz');
      const role = await request(h.app)
        .post('/api/access-control/roles')
        .send({ name: 'custom:t-assign', permissions: [] });
      const postRes = await request(h.app)
        .post(`/api/access-control/teams/${teamId}/roles`)
        .send({ roleUid: role.body.uid });
      expect(postRes.status).toBe(204);

      const delRes = await request(h.app).delete(
        `/api/access-control/teams/${teamId}/roles/${role.body.uid}`,
      );
      expect(delRes.status).toBe(204);
    });
  });

  describe('GET /status', () => {
    it('returns enabled status without auth-check', async () => {
      const h = await makeHarness('None');
      const res = await request(h.app).get('/api/access-control/status');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ enabled: true, rbacEnabled: true });
    });
  });

  describe('POST /seed', () => {
    it('403 for a non-admin', async () => {
      const h = await makeHarness('Viewer');
      const res = await request(h.app).post('/api/access-control/seed');
      expect(res.status).toBe(403);
    });

    it('200 for admin, idempotent', async () => {
      const h = await makeHarness('Admin');
      const res = await request(h.app).post('/api/access-control/seed');
      expect(res.status).toBe(200);
      expect(res.body.rolesInserted).toBe(0); // setup already seeded.
    });
  });

  describe('GET /users/:userId/permissions', () => {
    it('returns action->scopes map for admin looking up a user', async () => {
      const h = await makeHarness('Admin');
      const res = await request(h.app).get(
        '/api/access-control/users/u_other/permissions',
      );
      expect(res.status).toBe(200);
      // Target has orgRole None → empty.
      expect(res.body).toEqual({});
    });

    it('403 for viewer', async () => {
      const h = await makeHarness('Viewer');
      const res = await request(h.app).get(
        '/api/access-control/users/u_other/permissions',
      );
      expect(res.status).toBe(403);
    });
  });
});
