import { createHmac, timingSafeEqual, randomUUID } from 'crypto';
import { Router, raw as expressRaw } from 'express';
import { createLogger } from '@agentic-obs/common';
import { authMiddleware } from '../middleware/auth.js';
const log = createLogger('webhooks');
// All event type strings as literals (avoids ESM init-time circular deps)
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
    'admin.created',
    'finding.updated',
    'feed_item.created',
    'feed_item.read',
];
// Webhook source -> eventBus event type mapping (string literals)
const SOURCE_EVENT_MAP = {
    // GitHub
    push: 'finding.created',
    pull_request: 'finding.created',
    // PagerDuty
    'incident.trigger': 'incident.created',
    'incident.resolve': 'incident.resolved',
    'incident.acknowledge': 'incident.updated',
    // GitLab
    Pipeline: 'finding.created',
    // Generic
    alert: 'finding.created',
    incident: 'incident.created',
};
// -- HMAC verification
export function verifySignature(payload, signature, secret) {
    if (!signature)
        return false;
    const sigValue = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    const expected = createHmac('sha256', secret).update(payload).digest('hex');
    try {
        return timingSafeEqual(Buffer.from(sigValue, 'hex'), Buffer.from(expected, 'hex'));
    }
    catch {
        return false;
    }
}
// -- Outbound delivery with exponential backoff
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
    if (deliveryLog.length >= MAX_DELIVERY_LOG)
        deliveryLog.shift();
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
                    'X-Agentic-Signature': `sha256=${sig}`,
                    'X-Agentic-Event': eventType,
                    'X-Delivery-Id': delivery.id,
                },
                body,
                signal: AbortSignal.timeout(10_000),
            });
            delivery.responseStatus = res.status;
            if (res.ok) {
                delivery.status = 'success';
                log.debug({ sub: sub.url, event: eventType }, 'webhook delivered');
                return;
            }
            delivery.error = `HTTP ${res.status}`;
        }
        catch (err) {
            delivery.error = err instanceof Error ? err.message : String(err);
        }
        if (attempt < RETRY_DELAYS_MS.length - 1)
            await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
    delivery.status = 'failed';
    log.warn({ url: sub.url, event: eventType, error: delivery.error }, 'webhook delivery failed');
}
export function createWebhookRouter(bus) {
    const eventBus = bus ?? {};
    // Per-instance state
    const subscriptions = new Map();
    const deliveryLog = [];
    const outboundUnsubs = [];
    // Start outbound webhook fan-out: subscribe to all event types
    for (const eventType of ALL_EVENT_TYPES) {
        outboundUnsubs.push(eventBus.subscribe?.(eventType, (event) => {
            for (const sub of subscriptions.values()) {
                if (!sub.active)
                    continue;
                if (!sub.events.includes(eventType) && !sub.events.includes('*'))
                    continue;
                void deliverWebhook(sub, eventType, event.payload, deliveryLog);
            }
        }) ?? (() => { }));
    }
    const router = Router();
    // POST /api/webhooks/:source - inbound webhook receiver
    // expressRaw() captures raw bytes before any JSON parsing for HMAC verification
    router.post('/webhooks/:source', expressRaw({ type: () => true }), async (req, res) => {
        const source = req.params['source'];
        const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? ''));
        // Signature verification if matching inbound subscription exists
        const signature = req.headers['x-hub-signature-256']
            ?? req.headers['x-gitlab-token']
            ?? req.headers['x-agentic-signature'];
        const sourceSub = [...subscriptions.values()].find((s) => s.active && s.description === `inbound:${source}`);
        if (sourceSub && signature) {
            if (!verifySignature(rawBody, signature, sourceSub.secret)) {
                res.status(401).json({ code: 'INVALID_SIGNATURE', message: 'Signature mismatch' });
                return;
            }
        }
        // Parse JSON from raw body (expressRaw gives us a buffer)
        let payload;
        try {
            payload = JSON.parse(rawBody.toString());
        }
        catch {
            payload = rawBody.toString();
        }
        // Derive event type from source/header
        const githubEvent = req.headers['x-github-event'];
        const messages = payload;
        const pagerdutyType = messages?.['event']
            ?? messages?.['messages']?.['event'];
        const rawEventKey = githubEvent ?? pagerdutyType ?? source;
        const eventType = SOURCE_EVENT_MAP[rawEventKey] ?? 'finding.created';
        const evt = {
            id: randomUUID(),
            source,
            event: rawEventKey,
            payload,
        };
        eventBus.publish?.(eventType, evt);
        log.debug({ source, eventType }, 'inbound webhook received');
        res.json({ received: true, eventId: evt.id, eventType });
    });
    // Webhook subscription CRUD (authenticated)
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
        res.status(204).send();
    });
    router.get('/webhook-subscriptions/:id/deliveries', authMiddleware, (req, res) => {
        const id = req.params['id'];
        const deliveries = deliveryLog.filter((d) => d.subscriptionId === id);
        res.json(deliveries);
    });
    return router;
}
//# sourceMappingURL=webhooks.js.map