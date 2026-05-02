import { describe, expect, it } from 'vitest';
import type { ChatSession } from '@agentic-obs/common';
import type { IChatSessionRepository } from '@agentic-obs/data-layer';
import { findOwnedChatSession, listOwnedChatSessions } from './chat-service.js';

type OwnedSession = ChatSession & { ownerUserId?: string | null };

function session(
  id: string,
  ownerUserId: string,
  orgId = 'org_a',
): OwnedSession {
  return {
    id,
    ownerUserId,
    orgId,
    title: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeStore(sessions: OwnedSession[]): IChatSessionRepository {
  return {
    create: async (input) => session(input.id, '', input.orgId),
    findById: async (id, scope) =>
      sessions.find((s) => s.id === id && s.orgId === scope?.orgId),
    findAll: async (_limit, scope) =>
      sessions.filter((s) => s.orgId === scope?.orgId),
    updateTitle: async () => undefined,
    updateContextSummary: async () => undefined,
    delete: async () => false,
  };
}

describe('chat session ownership helpers', () => {
  it('requires the persisted owner to match for direct session lookup', async () => {
    const store = makeStore([session('s_owner', 'u_owner')]);

    await expect(
      findOwnedChatSession(store, 's_owner', {
        orgId: 'org_a',
        ownerUserId: 'u_owner',
      }),
    ).resolves.toMatchObject({ id: 's_owner' });

    await expect(
      findOwnedChatSession(store, 's_owner', {
        orgId: 'org_a',
        ownerUserId: 'u_other',
      }),
    ).resolves.toBeUndefined();
  });

  it('filters session lists to the authenticated owner', async () => {
    const store = makeStore([
      session('s_owner', 'u_owner'),
      session('s_other', 'u_other'),
      session('s_other_org', 'u_owner', 'org_b'),
    ]);

    await expect(
      listOwnedChatSessions(store, 50, {
        orgId: 'org_a',
        ownerUserId: 'u_owner',
      }),
    ).resolves.toEqual([expect.objectContaining({ id: 's_owner' })]);
  });
});
