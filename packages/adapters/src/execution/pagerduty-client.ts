// PagerDutyClient - interface + stub + HTTP implementation for PagerDuty Events API

// -- PagerDuty API types --

export type PagerDutySeverity = 'critical' | 'error' | 'warning' | 'info';
export type PagerDutyEventAction = 'trigger' | 'acknowledge' | 'resolve';

export interface PagerDutyPayload {
  summary: string;
  source: string;
  severity: PagerDutySeverity;
  component?: string;
  group?: string;
  class?: string;
  custom_details?: Record<string, unknown>;
}

export interface PagerDutyEvent {
  routing_key: string;
  event_action: PagerDutyEventAction;
  dedup_key?: string;
  payload?: PagerDutyPayload;
  client?: string;
  client_url?: string;
  links?: Array<{ href: string; text: string }>;
}

export interface PagerDutyEventResponse {
  status: string;
  message: string;
  dedup_key: string;
}

export interface PagerDutyNoteResponse {
  notes: { content: string };
}

// -- Client result --

export interface PagerDutyResult {
  success: boolean;
  statusCode: number;
  dedupKey?: string;
  error?: string;
}

// -- Interface --

export interface PagerDutyClient {
  /**
   * Send an event to the PagerDuty Events API v2.
   * Used for trigger / acknowledge / resolve actions.
   */
  sendEvent(event: PagerDutyEvent): Promise<PagerDutyResult>;

  /**
   * Add a note to an existing incident (requires REST API, not Events API).
   * `incidentId` is the PagerDuty incident ID (not dedup_key).
   */
  addNote(apiKey: string, incidentId: string, content: string, callerId: string): Promise<PagerDutyResult>;
}

// -- Stub implementation --

const STUB_DEDUP_KEY = 'stub-dedup-key-0001';

export class StubPagerDutyClient implements PagerDutyClient {
  readonly eventCalls: PagerDutyEvent[] = [];
  readonly noteCalls: Array<{ incidentId: string; content: string }> = [];

  async sendEvent(event: PagerDutyEvent): Promise<PagerDutyResult> {
    this.eventCalls.push(event);
    return { success: true, statusCode: 202, dedupKey: event.dedup_key ?? STUB_DEDUP_KEY };
  }

  async addNote(
    _apiKey: string,
    incidentId: string,
    content: string,
    _callerId: string,
  ): Promise<PagerDutyResult> {
    this.noteCalls.push({ incidentId, content });
    return { success: true, statusCode: 201 };
  }
}

// -- HTTP implementation --

const EVENTS_API_URL = 'https://events.pagerduty.com/v2/enqueue';
const REST_API_URL = 'https://api.pagerduty.com';
const HTTP_TIMEOUT_MS = 30_000;

export class HttpPagerDutyClient implements PagerDutyClient {
  async sendEvent(event: PagerDutyEvent): Promise<PagerDutyResult> {
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
        const body = (await res.json()) as PagerDutyEventResponse;
        return { success: true, statusCode: res.status, dedupKey: body.dedup_key };
      }
      return { success: false, statusCode: res.status, error: `PagerDuty returned HTTP ${res.status}` };
    } catch (err) {
      return { success: false, statusCode: 0, error: String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  async addNote(
    apiKey: string,
    incidentId: string,
    content: string,
    callerId: string,
  ): Promise<PagerDutyResult> {
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
    } catch (err) {
      return { success: false, statusCode: 0, error: String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}