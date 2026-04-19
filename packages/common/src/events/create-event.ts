// Node-only helper that wraps `randomUUID` into an EventEnvelope. Lives in
// its own file so ./types.ts stays frontend-safe (the main barrel re-exports
// the pure EventEnvelope type + EventTypes constants from ./types.js).

import { randomUUID } from 'crypto';
import type { EventEnvelope } from './types.js';

export function createEvent<T>(
  type: string,
  payload: T,
  tenantId?: string,
): EventEnvelope<T> {
  return {
    id: randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    tenantId,
    payload,
  };
}
