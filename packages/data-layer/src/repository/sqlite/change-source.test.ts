import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { SqliteChangeSourceRepository } from './change-source.js';

describe('SqliteChangeSourceRepository', () => {
  const prevSecret = process.env['SECRET_KEY'];
  let db: SqliteClient;
  let repo: SqliteChangeSourceRepository;

  beforeAll(() => {
    process.env['SECRET_KEY'] =
      prevSecret ?? 'test-secret-key-for-change-source-repository-xxxxxxxx';
  });

  afterAll(() => {
    if (prevSecret === undefined) delete process.env['SECRET_KEY'];
    else process.env['SECRET_KEY'] = prevSecret;
  });

  beforeEach(() => {
    db = createTestDb();
    db.run(sql`INSERT INTO org (id, name, created, updated) VALUES ('org_a', 'Org A', 'now', 'now')`);
    db.run(sql`INSERT INTO org (id, name, created, updated) VALUES ('org_b', 'Org B', 'now', 'now')`);
    repo = new SqliteChangeSourceRepository(db);
  });

  it('creates and lists GitHub change sources by org with masked secrets', async () => {
    await repo.createSource({
      id: 'gh-a',
      orgId: 'org_a',
      type: 'github',
      name: 'Prod deploys',
      owner: 'openobs',
      repo: 'openobs',
      events: ['deployment'],
      secret: 'super-secret',
    });
    await repo.createSource({
      id: 'gh-b',
      orgId: 'org_b',
      type: 'github',
      name: 'Other deploys',
    });

    const orgA = await repo.listSources('org_a', { masked: true });
    expect(orgA).toHaveLength(1);
    expect(orgA[0]).toMatchObject({
      id: 'gh-a',
      orgId: 'org_a',
      owner: 'openobs',
      repo: 'openobs',
      events: ['deployment'],
      secret: '••••••cret',
    });
    expect(await repo.findSourceByIdInOrg('org_b', 'gh-a')).toBeNull();
  });

  it('persists change events and filters by org source service and time', async () => {
    await repo.createSource({
      id: 'gh-a',
      orgId: 'org_a',
      type: 'github',
      name: 'Prod deploys',
    });
    await repo.addEvent({
      id: 'chg-a',
      orgId: 'org_a',
      sourceId: 'gh-a',
      serviceId: 'openobs/openobs',
      type: 'deploy',
      timestamp: '2026-04-30T10:00:00.000Z',
      author: 'octocat',
      description: 'Deploy main',
      version: 'abc123',
      payload: { action: 'created' },
    });

    const events = await repo.listEvents({
      orgId: 'org_a',
      sourceId: 'gh-a',
      serviceId: 'openobs/openobs',
      startTime: '2026-04-30T09:00:00.000Z',
      endTime: '2026-04-30T11:00:00.000Z',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 'chg-a',
      orgId: 'org_a',
      sourceId: 'gh-a',
      serviceId: 'openobs/openobs',
      version: 'abc123',
      payload: { action: 'created' },
    });
    expect((await repo.findSourceByIdInOrg('org_a', 'gh-a'))!.lastEventAt).toBeTruthy();
    expect(await repo.listEvents({
      orgId: 'org_b',
      startTime: '2026-04-30T09:00:00.000Z',
      endTime: '2026-04-30T11:00:00.000Z',
    })).toEqual([]);
  });
});
