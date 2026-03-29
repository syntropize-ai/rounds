import { createHmac, timingSafeEqual, randomUUID } from 'crypto';
import { Router, raw as expressRaw } from 'express';
import { createEventBusFromEnv, createEvent } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common';
import { authMiddleware } from '../middleware/auth.js';
const log = createLogger('webhooks');
const ALL_EVENT_TYPES = [
    'investigation.created',
    'investigation.updated',
    'investigation.completed',
    'investigation.failed',
    'incident.created',
    'incident.updated',
    'incident.resolved',
    'action.requested',
    'action.approved',
    'action.rejected',
    'action.executed',
    'action.failed',
    'finding.created',
    'finding.updated',
    'feed.item.created',
    'feed.item.read',
];
const SOURCE_EVENT_MAP = {
    push: 'finding.created',
    pull_request: 'finding.created',
    incident.trigger: 'incident.created',
    incident.resolve: 'incident.resolved',
    incident.acknowledge: 'incident.updated',
    Pipeline: 'finding.created',
    alerts: 'finding.created',
    incidents: 'incident.created',
};
export function verifySignature(payload, signature, secret) {
    if (!signature) {
        return false;
    }
    try {
        const sigValue = signature.startsWith('sha256=') ? signature.slice(7) : signature;
        const expected = createHmac('sha256', secret).update(payload).digest('hex');
        return timingSafeEqual(Buffer.from(sigValue, 'hex'), Buffer.from(expected, 'hex'));
    }
    catch {
        return false;
    }
}
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000];
const MAX_DELIVERY_LOG = 1000;
async function deliverWebhook(sub, eventType, payload, deliveryLog) {
    const delivery = {
        id: randomUUID(),
        subscriptionId: sub.id,
        event: eventType,
        url: sub.url,
        status: 'pending',
        attempts: 0,
    };
    if (deliveryLog.length >= MAX_DELIVERY_LOG) {
        deliveryLog.shift();
    }
    deliveryLog.push(delivery);
    const body = JSON.stringify({ event: eventType, payload, deliveryId: delivery.id });
    const sig = createHmac('sha256', sub.secret).update(body).digest('hex');
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
        delivery.attempts = attempt + 1;
        delivery.lastAttemptAt = new Date().toISOString();
        try {
            const res = await fetch(sub.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Agent-Signature': `sha256=${sig}`,
                    'X-Agent-Event': eventType,
                    'X-Delivery-Id': delivery.id,
                },
                body,
                signal: AbortSignal.timeout(10_000),
            });
            delivery.responseStatus = res.status;
            if (res.ok) {
                delivery.status = 'success';
                log.debug({ url: sub.url, event: eventType }, 'webhook delivered');
                return;
            }
            delivery.error = `HTTP ${res.status}`;
        }
        catch (err) {
            delivery.error = err instanceof Error ? err.message : String(err);
        }
        if (attempt < RETRY_DELAYS_MS.length - 1) {
            await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        }
    }
    delivery.status = 'failed';
    log.warn({ url: sub.url, event: eventType, error: delivery.error }, 'webhook delivery failed');
}
export function createWebhookRouter(bus) {
    const eventBus = bus ?? createEventBusFromEnv();
    // Per-instance state
    const subscriptions = new Map();
    const deliveryLog = [];
    const outboundUnsubs = [];
    for (const eventType of ALL_EVENT_TYPES) {
        outboundUnsubs.push(eventBus.subscribe(eventType, event => {
            for (const sub of subscriptions.values()) {
                if (!sub.active) {
                    continue;
                }
                if (!sub.events.includes(eventType) && !sub.events.includes('*')) {
                    continue;
                }
                void deliverWebhook(sub, eventType, event.payload, deliveryLog);
            }
        }));
    }
    const router = Router();
    router.post('/webhooks/source/:source', expressRaw({ type: () => true }), async (req, res) => {
        const source = req.params['source'];
        const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
        const signatureHeader = req.headers['x-hub-signature-256'] ??
            req.headers['x-gitlab-token'] ??
            req.headers['authorization'];
        const sourceSub = [...subscriptions.values()].find(s => s.active && s.description === `inbound:${source}`);
        if (sourceSub && !verifySignature(rawBody, signatureHeader, sourceSub.secret)) {
            res.status(401).json({ code: 'INVALID_SIGNATURE', message: 'Signature mismatch' });
            return;
        }
        let payload;
        try {
            payload = JSON.parse(rawBody.toString());
        }
        catch {
            payload = rawBody.toString();
        }
        const githubEvent = req.headers['x-github-event'];
        const messages = payload?.['messages'];
        const pagerdutyEvent = (Array.isArray(messages) ? messages[0]?.['event'] : undefined);
        const rawEventKey = githubEvent ?? pagerdutyEvent ?? source;
        const eventType = SOURCE_EVENT_MAP[rawEventKey] ?? 'finding.created';
        const event = createEvent(eventType, { source, rawEventKey, payload });
        await eventBus.publish(eventType, event);
        log.debug({ source, eventType }, 'inbound webhook received');
        res.json({ received: true, eventId: event.id, eventType });
    });
    router.get('/webhook-subscriptions', authMiddleware, (_req, res) => {
        res.json([...subscriptions.values()]);
    });
    router.post('/webhook-subscriptions', authMiddleware, (req, res) => {
        const { url, events, secret, active = true, description } = req.body;
        if (!url || !events || !Array.isArray(events) || events.length === 0) {
            res.status(400).json({ code: 'INVALID_INPUT', message: 'url and events[] are required' });
            return;
        }
        const sub = {
            id: randomUUID(),
            url,
            events,
            secret: secret ?? randomUUID(),
            active,
            createdAt: new Date().toISOString(),
            description,
        };
        subscriptions.set(sub.id, sub);
        log.info({ id: sub.id, url }, 'webhook subscription created');
        res.status(201).json(sub);
    });
    router.get('/webhook-subscriptions/:id', authMiddleware, (req, res) => {
        const sub = subscriptions.get(req.params['id']);
        if (!sub) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Subscription not found' });
            return;
        }
        res.json(sub);
    });
    router.put('/webhook-subscriptions/:id', authMiddleware, (req, res) => {
        const sub = subscriptions.get(req.params['id']);
        if (!sub) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Subscription not found' });
            return;
        }
        const { url, events, secret, active, description } = req.body;
        const updated = {
            ...sub,
            ...(url !== undefined && { url }),
            ...(events !== undefined && { events }),
            ...(secret !== undefined && { secret }),
            ...(active !== undefined && { active }),
            ...(description !== undefined && { description }),
        };
        subscriptions.set(sub.id, updated);
        res.json(updated);
    });
    router.delete('/webhook-subscriptions/:id', authMiddleware, (req, res) => {
        const id = req.params['id'];
        if (!subscriptions.has(id)) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Subscription not found' });
            return;
        }
        subscriptions.delete(id);
        res.status(204).end();
    });
    router.get('/webhook-subscriptions/:id/deliveries', authMiddleware, (req, res) => {
        const id = req.params['id'];
        const deliveries = deliveryLog.filter(d => d.subscriptionId === id);
        res.json(deliveries);
    });
    return {
        router,
        stop() {
            for (const unsub of outboundUnsubs) {
                unsub();
            }
        },
    };
}
//# sourceMappingURL=webhooks.js.map
