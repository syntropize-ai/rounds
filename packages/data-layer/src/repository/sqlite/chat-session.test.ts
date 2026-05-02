import { describe, it, expect, beforeEach } from 'vitest';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { SqliteChatSessionRepository } from './chat-session.js';
import { SqliteChatSessionContextRepository } from './chat-session-context.js';

describe('SqliteChatSessionRepository', () => {
  let db: SqliteClient;
  let sessions: SqliteChatSessionRepository;
  let contexts: SqliteChatSessionContextRepository;

  beforeEach(() => {
    db = createTestDb();
    sessions = new SqliteChatSessionRepository(db);
    contexts = new SqliteChatSessionContextRepository(db);
  });

  it('scopes sessions by org and owner when requested', async () => {
    await sessions.create({
      id: 's-a',
      orgId: 'org-1',
      ownerUserId: 'user-a',
      title: 'A',
    });
    await sessions.create({
      id: 's-b',
      orgId: 'org-1',
      ownerUserId: 'user-b',
      title: 'B',
    });
    await sessions.create({
      id: 's-c',
      orgId: 'org-2',
      ownerUserId: 'user-a',
      title: 'C',
    });

    expect(
      await sessions.findById('s-a', { orgId: 'org-1', ownerUserId: 'user-a' }),
    ).toMatchObject({
      id: 's-a',
      ownerUserId: 'user-a',
    });
    expect(
      await sessions.findById('s-a', { orgId: 'org-1', ownerUserId: 'user-b' }),
    ).toBeUndefined();
    expect(
      (
        await sessions.findAll(10, { orgId: 'org-1', ownerUserId: 'user-a' })
      ).map((s) => s.id),
    ).toEqual(['s-a']);
  });

  it('keeps unowned sessions readable through legacy unscoped lookups', async () => {
    const created = await sessions.create({ id: 'legacy', orgId: 'org-1' });

    expect(created.ownerUserId).toBeUndefined();
    expect(await sessions.findById('legacy')).toMatchObject({ id: 'legacy' });
    expect(
      await sessions.findById('legacy', {
        orgId: 'org-1',
        ownerUserId: 'user-a',
      }),
    ).toBeUndefined();
  });

  it('stores and filters resource contexts by owner', async () => {
    await sessions.create({ id: 's-a', orgId: 'org-1', ownerUserId: 'user-a' });
    await sessions.create({ id: 's-b', orgId: 'org-1', ownerUserId: 'user-b' });
    await contexts.create({
      id: 'ctx-a',
      sessionId: 's-a',
      orgId: 'org-1',
      ownerUserId: 'user-a',
      resourceType: 'dashboard',
      resourceId: 'dash-1',
      relation: 'created_from_chat',
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    await contexts.create({
      id: 'ctx-b',
      sessionId: 's-b',
      orgId: 'org-1',
      ownerUserId: 'user-b',
      resourceType: 'dashboard',
      resourceId: 'dash-1',
      relation: 'viewed_with_chat',
      createdAt: '2026-05-01T00:01:00.000Z',
    });

    expect(
      (
        await contexts.listBySession('s-a', {
          orgId: 'org-1',
          ownerUserId: 'user-a',
        })
      ).map((c) => c.id),
    ).toEqual(['ctx-a']);
    expect(
      (
        await contexts.listByResource({
          orgId: 'org-1',
          ownerUserId: 'user-b',
          resourceType: 'dashboard',
          resourceId: 'dash-1',
        })
      ).map((c) => c.id),
    ).toEqual(['ctx-b']);
  });
});
