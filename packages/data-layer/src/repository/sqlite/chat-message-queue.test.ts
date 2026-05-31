import { describe, it, expect, beforeEach } from 'vitest';
import type { Identity } from '@agentic-obs/common';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { SqliteChatMessageQueueRepository } from './chat-message-queue.js';
import { SqliteChatSessionEventRepository } from './chat-session-event.js';

const identity: Identity = {
  userId: 'user-1',
  orgId: 'org-1',
  orgRole: 'Viewer',
  isServerAdmin: false,
  authenticatedBy: 'session',
};

describe('SqliteChatMessageQueueRepository', () => {
  let db: SqliteClient;
  let queue: SqliteChatMessageQueueRepository;
  let events: SqliteChatSessionEventRepository;

  beforeEach(() => {
    db = createTestDb();
    queue = new SqliteChatMessageQueueRepository(db);
    events = new SqliteChatSessionEventRepository(db);
  });

  it('claims queued messages in session order', async () => {
    await queue.enqueue({
      id: 'q1',
      sessionId: 's1',
      orgId: 'org-1',
      ownerUserId: 'user-1',
      content: 'first',
      identity,
    });
    await queue.enqueue({
      id: 'q2',
      sessionId: 's1',
      orgId: 'org-1',
      ownerUserId: 'user-1',
      content: 'second',
      identity,
    });

    const first = await queue.claimNext('s1');
    const second = await queue.claimNext('s1');
    const empty = await queue.claimNext('s1');

    expect(first).toMatchObject({ id: 'q1', status: 'running', position: 1 });
    expect(second).toMatchObject({ id: 'q2', status: 'running', position: 2 });
    expect(empty).toBeNull();
  });

  it('assigns event sequence numbers at append time', async () => {
    const first = await events.appendNext({
      id: 'e1',
      sessionId: 's1',
      kind: 'message_queued',
      payload: { type: 'message_queued', queueItemId: 'q1', sessionId: 's1', position: 1 },
      timestamp: '2026-05-31T00:00:00.000Z',
    });
    const second = await events.appendNext({
      id: 'e2',
      sessionId: 's1',
      kind: 'thinking',
      payload: { type: 'thinking', content: 'Working' },
      timestamp: '2026-05-31T00:00:01.000Z',
    });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
  });

  it('allows editing and deleting only queued messages', async () => {
    await queue.enqueue({
      id: 'q1',
      sessionId: 's1',
      orgId: 'org-1',
      ownerUserId: 'user-1',
      content: 'draft',
      identity,
    });

    expect(await queue.updateQueuedContent('q1', 'edited')).toMatchObject({
      id: 'q1',
      content: 'edited',
    });
    expect(await queue.deleteQueued('q1')).toMatchObject({
      id: 'q1',
      content: 'edited',
    });
    expect(await queue.deleteQueued('q1')).toBeNull();

    await queue.enqueue({
      id: 'q2',
      sessionId: 's1',
      orgId: 'org-1',
      ownerUserId: 'user-1',
      content: 'already running',
      identity,
    });
    await queue.claimNext('s1');

    expect(await queue.updateQueuedContent('q2', 'too late')).toBeNull();
    expect(await queue.deleteQueued('q2')).toBeNull();
  });
});
