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
} from '@agentic-obs/data-layer';
import type { Identity } from '@agentic-obs/common';
import { AccessControlService } from '../services/accesscontrol-service.js';
import { createUserPermissionsRouter } from './user-permissions.js';

async function makeApp(identity: Identity | null): Promise<express.Express> {
  const db = createTestDb();
  await seedDefaultOrg(db);
  await seedRbacForOrg(db, 'org_main');
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
    if (identity) (req as express.Request & { auth?: Identity }).auth = identity;
    next();
  });
  app.use('/api/user', createUserPermissionsRouter(ac));
  return app;
}

describe('GET /api/user/permissions', () => {
  it('401 without authentication', async () => {
    const app = await makeApp(null);
    const res = await request(app).get('/api/user/permissions');
    expect(res.status).toBe(401);
  });

  it('returns action->scopes map for a Viewer', async () => {
    const id: Identity = {
      userId: 'u_v',
      orgId: 'org_main',
      orgRole: 'Viewer',
      isServerAdmin: false,
      authenticatedBy: 'session',
    };
    const app = await makeApp(id);
    const res = await request(app).get('/api/user/permissions');
    expect(res.status).toBe(200);
    expect(res.body['dashboards:read']).toBeDefined();
    expect(res.body['dashboards:read']).toContain('dashboards:*');
    // A viewer cannot write.
    expect(res.body['dashboards:write']).toBeUndefined();
  });

  it('returns every-catalog action for a Server Admin', async () => {
    const id: Identity = {
      userId: 'u_sa',
      orgId: 'org_main',
      orgRole: 'None',
      isServerAdmin: true,
      authenticatedBy: 'session',
    };
    const app = await makeApp(id);
    const res = await request(app).get('/api/user/permissions');
    expect(res.status).toBe(200);
    // Spot-check a handful of actions all present.
    expect(res.body['dashboards:read']).toBeDefined();
    expect(res.body['orgs:create']).toBeDefined();
    expect(res.body['users:create']).toBeDefined();
  });

  it('returns {} for None orgRole non-server-admin', async () => {
    const id: Identity = {
      userId: 'u_none',
      orgId: 'org_main',
      orgRole: 'None',
      isServerAdmin: false,
      authenticatedBy: 'session',
    };
    const app = await makeApp(id);
    const res = await request(app).get('/api/user/permissions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
});
