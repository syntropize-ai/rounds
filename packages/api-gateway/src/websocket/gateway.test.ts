import express from 'express';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import { EventTypes, type EventEnvelope, type EventHandler, type IEventBus } from '@agentic-obs/common';

const jwtSecret = 'test-websocket-secret-xxxxxxxxxxxxxxxx';

vi.hoisted(() => {
  process.env['JWT_SECRET'] = 'test-websocket-secret-xxxxxxxxxxxxxxxx';
});

const { authenticateHandshake, createWebSocketGateway } = await import('./gateway.js');

class TestEventBus implements IEventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  async publish<T>(topic: string, evt: EventEnvelope<T>): Promise<void> {
    for (const handler of this.handlers.get(topic) ?? []) {
      await handler(evt);
    }
  }

  subscribe<T>(topic: string, handler: EventHandler<T>): () => void {
    const set = this.handlers.get(topic) ?? new Set<EventHandler>();
    set.add(handler as EventHandler);
    this.handlers.set(topic, set);
    return () => set.delete(handler as EventHandler);
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}

function event<T>(type: string, payload: T): EventEnvelope<T> {
  return {
    id: `evt_${Math.random().toString(16).slice(2)}`,
    type,
    timestamp: new Date().toISOString(),
    payload,
  };
}

describe('createWebSocketGateway event bridge', () => {
  it('sends investigation events only to the resource room', async () => {
    const bus = new TestEventBus();
    const { gateway } = createWebSocketGateway(express(), bus);
    const ns = gateway.io.of('/investigations');
    const namespaceEmit = vi.spyOn(ns, 'emit');
    const roomEmit = vi.fn();
    vi.spyOn(ns, 'to').mockReturnValue({ emit: roomEmit } as never);

    await bus.publish(
      EventTypes.INVESTIGATION_UPDATED,
      event(EventTypes.INVESTIGATION_UPDATED, { investigationId: 'inv_1' }),
    );

    expect(ns.to).toHaveBeenCalledWith('investigation:inv_1');
    expect(roomEmit).toHaveBeenCalledWith(
      EventTypes.INVESTIGATION_UPDATED,
      expect.objectContaining({ payload: { investigationId: 'inv_1' } }),
    );
    expect(namespaceEmit).not.toHaveBeenCalled();
    await gateway.close();
  });

  it('drops events without a resource id instead of namespace broadcasting', async () => {
    const bus = new TestEventBus();
    const { gateway } = createWebSocketGateway(express(), bus);
    const investigations = gateway.io.of('/investigations');
    const approvals = gateway.io.of('/approvals');
    const feed = gateway.io.of('/feed');
    const investigationEmit = vi.spyOn(investigations, 'emit');
    const approvalEmit = vi.spyOn(approvals, 'emit');
    const feedEmit = vi.spyOn(feed, 'emit');
    const investigationTo = vi.spyOn(investigations, 'to');
    const approvalTo = vi.spyOn(approvals, 'to');
    const feedTo = vi.spyOn(feed, 'to');

    await bus.publish(
      EventTypes.INVESTIGATION_UPDATED,
      event(EventTypes.INVESTIGATION_UPDATED, {}),
    );
    await bus.publish(
      EventTypes.ACTION_REQUESTED,
      event(EventTypes.ACTION_REQUESTED, {}),
    );
    await bus.publish(
      EventTypes.FEED_ITEM_CREATED,
      event(EventTypes.FEED_ITEM_CREATED, {}),
    );

    expect(investigationEmit).not.toHaveBeenCalled();
    expect(approvalEmit).not.toHaveBeenCalled();
    expect(feedEmit).not.toHaveBeenCalled();
    expect(investigationTo).not.toHaveBeenCalled();
    expect(approvalTo).not.toHaveBeenCalled();
    expect(feedTo).not.toHaveBeenCalled();
    await gateway.close();
  });
});

describe('authenticateHandshake', () => {
  it('rejects legacy API key handshakes', () => {
    process.env['API_KEYS'] = 'legacy:super-secret';

    expect(() =>
      authenticateHandshake({
        auth: { apiKey: 'super-secret' },
        headers: { 'x-api-key': 'super-secret' },
      }),
    ).toThrow(/Authentication required/);
  });

  it('accepts JWT handshakes with org identity', () => {
    const token = jwt.sign({ sub: 'user_a', orgId: 'org_a', orgRole: 'Viewer' }, jwtSecret);

    expect(authenticateHandshake({
      auth: { token },
      headers: {},
    })).toMatchObject({
      sub: 'user_a',
      type: 'jwt',
      identity: {
        userId: 'user_a',
        orgId: 'org_a',
        orgRole: 'Viewer',
        authenticatedBy: 'session',
      },
    });
  });

  it('rejects JWT handshakes without org identity', () => {
    const token = jwt.sign({ sub: 'user_a' }, jwtSecret);

    expect(() =>
      authenticateHandshake({
        auth: { token },
        headers: {},
      }),
    ).toThrow(/sub and orgId/);
  });
});
