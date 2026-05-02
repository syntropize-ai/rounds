import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import type { Evaluator, Identity, ResolvedPermission } from '@agentic-obs/common';
import { setAuthMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import { GitHubChangeSourceRegistry } from '../services/github-change-source-service.js';
import { createGithubChangeSourcesRouter } from './github-change-sources.js';
import { createTestDb } from '../../../data-layer/src/test-support/test-db.js';
import { SqliteChangeSourceRepository } from '../../../data-layer/src/repository/sqlite/change-source.js';

function identity(orgId: string): Identity {
  return {
    userId: 'u_1',
    orgId,
    orgRole: 'Admin',
    isServerAdmin: false,
    authenticatedBy: 'session',
  };
}

function makeAccessControl(): AccessControlSurface {
  return {
    getUserPermissions: async (): Promise<ResolvedPermission[]> => [],
    ensurePermissions: async (): Promise<ResolvedPermission[]> => [],
    evaluate: async (_id: Identity, _evaluator: Evaluator): Promise<boolean> => true,
    filterByPermission: async <T>(_id: Identity, items: T[]): Promise<T[]> => items,
  };
}

function makeApp(orgId = 'org_a') {
  const db = createTestDb();
  db.run(sql`INSERT INTO org (id, name, created, updated) VALUES ('org_a', 'Org A', 'now', 'now')`);
  db.run(sql`INSERT INTO org (id, name, created, updated) VALUES ('org_b', 'Org B', 'now', 'now')`);
  const registry = new GitHubChangeSourceRegistry(new SqliteChangeSourceRepository(db));
  setAuthMiddleware((req: AuthenticatedRequest, _res, next) => {
    req.auth = identity(orgId);
    next();
  });
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  }));
  app.use('/api/change-sources', createGithubChangeSourcesRouter({
    registry,
    ac: makeAccessControl(),
  }));
  return { app, registry };
}

function sign(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')}`;
}

function githubDeploymentBody(): string {
  return JSON.stringify({
    deployment: {
      id: 1,
      ref: 'main',
      sha: 'abc123',
      environment: 'production',
      description: 'Deploy main',
      created_at: new Date().toISOString(),
      creator: { login: 'octocat' },
    },
    repository: { full_name: 'openobs/openobs' },
  });
}

describe('GitHub change source routes', () => {
  const prevSecret = process.env['SECRET_KEY'];

  beforeAll(() => {
    process.env['SECRET_KEY'] =
      prevSecret ?? 'test-secret-key-for-github-change-routes-xxxxxxxx';
  });

  afterAll(() => {
    if (prevSecret === undefined) delete process.env['SECRET_KEY'];
    else process.env['SECRET_KEY'] = prevSecret;
  });

  afterEach(() => {
    setAuthMiddleware(null);
  });

  it('creates and lists GitHub sources in the authenticated org', async () => {
    const { app } = makeApp('org_a');

    const created = await request(app)
      .post('/api/change-sources/github')
      .send({
        name: 'Prod deploys',
        owner: 'openobs',
        repo: 'openobs',
        secret: 'super-secret',
      })
      .expect(201);

    expect(created.body.source.orgId).toBe('org_a');
    expect(created.body.source.secret).toBe('super-secret');
    expect(created.body.source.secretMasked).toBe('••••••cret');

    const listed = await request(app).get('/api/change-sources/github').expect(200);
    expect(listed.body.sources).toHaveLength(1);
    expect(listed.body.sources[0].secret).toBeUndefined();
  });

  it('verifies GitHub signatures and ingests deployment events', async () => {
    const { app, registry } = makeApp('org_a');
    const source = await registry.create({
      orgId: 'org_a',
      name: 'Prod deploys',
      secret: 'webhook-secret',
    });
    const body = githubDeploymentBody();

    await request(app)
      .post(`/api/change-sources/github/${source.id}/webhook`)
      .set('X-GitHub-Event', 'deployment')
      .set('X-Hub-Signature-256', sign(body, 'webhook-secret'))
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);

    const records = await (await registry.listAdapters('org_a'))[0]!.adapter.listRecent({ windowMinutes: 60 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ service: 'openobs/openobs', kind: 'deploy' });
  });

  it('rejects webhook requests with invalid signatures', async () => {
    const { app, registry } = makeApp('org_a');
    const source = await registry.create({
      orgId: 'org_a',
      name: 'Prod deploys',
      secret: 'webhook-secret',
    });

    await request(app)
      .post(`/api/change-sources/github/${source.id}/webhook`)
      .set('X-GitHub-Event', 'deployment')
      .set('X-Hub-Signature-256', 'sha256=deadbeef')
      .set('Content-Type', 'application/json')
      .send(githubDeploymentBody())
      .expect(401);
  });
});
