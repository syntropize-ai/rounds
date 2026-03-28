import type { Change } from '@agentic-obs/common';
import type { WebhookPayload } from './types.js';
/**
 * Normalize a webhook payload into a Change object.
 * Returns null if the payload should be ignored (e.g. pending GitHub deployments).
 */
export declare function normalizeWebhook(event: WebhookPayload): Change | null;
//# sourceMappingURL=normalizer.d.ts.map