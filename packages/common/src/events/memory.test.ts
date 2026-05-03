import { describe, expect, it, vi } from 'vitest';
import { InMemoryEventBus } from './memory.js';
import type { EventEnvelope } from './types.js';

function makeEvent<T>(type: string, payload: T): EventEnvelope<T> {
  return {
    id: 'id-1',
    type,
    timestamp: new Date().toISOString(),
    payload,
  };
}

describe('InMemoryEventBus', () => {
  it('delivers a published event to a subscriber', async () => {
    const bus = new InMemoryEventBus();
    const handler = vi.fn();
    bus.subscribe<{ n: number }>('topic.a', handler);

    const evt = makeEvent('topic.a', { n: 1 });
    await bus.publish('topic.a', evt);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(evt);
    await bus.close();
  });

  it('delivers to multiple subscribers on the same topic', async () => {
    const bus = new InMemoryEventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.subscribe('topic.b', h1);
    bus.subscribe('topic.b', h2);

    await bus.publish('topic.b', makeEvent('topic.b', { ok: true }));

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    await bus.close();
  });

  it('unsubscribe stops delivery', async () => {
    const bus = new InMemoryEventBus();
    const handler = vi.fn();
    const unsubscribe = bus.subscribe('topic.c', handler);

    await bus.publish('topic.c', makeEvent('topic.c', {}));
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    await bus.publish('topic.c', makeEvent('topic.c', {}));
    expect(handler).toHaveBeenCalledTimes(1);
    await bus.close();
  });

  it('does not cross topics', async () => {
    const bus = new InMemoryEventBus();
    const handler = vi.fn();
    bus.subscribe('topic.x', handler);

    await bus.publish('topic.y', makeEvent('topic.y', {}));
    expect(handler).not.toHaveBeenCalled();
    await bus.close();
  });
});
