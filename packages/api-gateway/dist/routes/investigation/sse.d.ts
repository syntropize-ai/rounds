import type { Response } from 'express';
import type { SseEvent, SseEventType } from './types.js';
/**
 * Configure an Express response for SSE streaming.
 * Sets headers and sends the initial connection keepalive.
 */
export declare function initSse(res: Response): void;
/** Write a single SSE event to the response. */
export declare function sendSseEvent<T>(res: Response, event: SseEvent<T>): void;
/** Send a keepalive comment (prevents proxy timeouts). */
export declare function sendSseKeepalive(res: Response): void;
/** Close an SSE stream gracefully. */
export declare function closeSse(res: Response): void;
/** Higher-level helper: stream a series of events then close. */
export declare function streamEvents<T>(res: Response, events: Array<{
    type: SseEventType;
    data?: T;
}>, delayMs?: number): Promise<void>;
//# sourceMappingURL=sse.d.ts.map
