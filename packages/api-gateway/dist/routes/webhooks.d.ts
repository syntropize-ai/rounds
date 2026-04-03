import { Router } from 'express';
import type { IEventBus } from '@agentic-obs/common';
export interface WebhookSubscription {
    id: string;
    url: string;
    events: string[];
    secret: string;
    active: boolean;
    createdAt: string;
    description?: string;
}
export interface WebhookDelivery {
    id: string;
    subscriptionId: string;
    event: string;
    url: string;
    status: 'pending' | 'success' | 'failed';
    attempts: number;
    lastAttemptAt?: string;
    responseStatus?: number;
    error?: string;
}
export declare function verifySignature(payload: Buffer, signature: string | undefined, secret: string): boolean;
export interface WebhookRouterHandle {
    router: Router;
    stop(): void;
}
export declare function createWebhookRouter(bus?: IEventBus): Router;
//# sourceMappingURL=webhooks.d.ts.map