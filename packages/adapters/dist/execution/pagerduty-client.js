// PagerDutyClient - interface + stub + HTTP implementation for PagerDuty Events API v2

// — Stub implementation ———————————————————————————————————————————————————————
const STUB_DEDUP_KEY = 'stub-dedup-key-0001';

export class StubPagerDutyClient {
    eventCalls = [];
    noteCalls = [];
    async sendEvent(event) {
        this.eventCalls.push(event);
        return { success: true, statusCode: 202, dedupKey: event.dedup_key ?? STUB_DEDUP_KEY };
    }
    async addNote(_apiKey, incidentId, content, _callerId) {
        this.noteCalls.push({ incidentId, content });
        return { success: true, statusCode: 201 };
    }
}

// — HTTP implementation ———————————————————————————————————————————————————————
const EVENTS_API_URL = 'https://events.pagerduty.com/v2/enqueue';
const REST_API_URL = 'https://api.pagerduty.com';
const HTTP_TIMEOUT_MS = 30_000;

export class HttpPagerDutyClient {
    async sendEvent(event) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
        try {
            const res = await fetch(EVENTS_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(event),
                signal: controller.signal,
            });
            if (res.ok) {
                const body = (await res.json());
                return { success: true, statusCode: res.status, dedupKey: body.dedup_key };
            }
            return { success: false, statusCode: res.status, error: `PagerDuty returned HTTP ${res.status}` };
        }
        catch (err) {
            return { success: false, statusCode: 0, error: String(err) };
        }
        finally {
            clearTimeout(timer);
        }
    }
    async addNote(apiKey, incidentId, content, callerId) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
        try {
            const res = await fetch(`${REST_API_URL}/incidents/${incidentId}/notes`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Token token=${apiKey}`,
                    From: callerId,
                },
                body: JSON.stringify({ note: { content } }),
                signal: controller.signal,
            });
            return { success: res.ok, statusCode: res.status };
        }
        catch (err) {
            return { success: false, statusCode: 0, error: String(err) };
        }
        finally {
            clearTimeout(timer);
        }
    }
}
//# sourceMappingURL=pagerduty-client.js.map