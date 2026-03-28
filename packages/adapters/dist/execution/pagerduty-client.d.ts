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
    links?: Array<{
        href: string;
        text: string;
    }>;
}
export interface PagerDutyEventResponse {
    status: string;
    message: string;
    dedup_key: string;
}
export interface PagerDutyNoteResponse {
    note: {
        content: string;
    };
}
export interface PagerDutyResult {
    success: boolean;
    statusCode: number;
    dedupKey?: string;
    error?: string;
}
export interface PagerDutyClient {
    /**
     * Send an event to the PagerDuty Events API v2.
     * Used for trigger / acknowledge / resolve actions.
     */
    sendEvent(event: PagerDutyEvent): Promise<PagerDutyResult>;
    /**
     * Add a note to an existing incident (requires REST API, not Events API).
     * `incidentId` is the PagerDuty incident ID (not dedup key).
     */
    addNote(apiKey: string, incidentId: string, content: string, callerId: string): Promise<PagerDutyResult>;
}
export declare class StubPagerDutyClient implements PagerDutyClient {
    readonly eventCalls: PagerDutyEvent[];
    readonly noteCalls: Array<{
        incidentId: string;
        content: string;
    }>;
    sendEvent(event: PagerDutyEvent): Promise<PagerDutyResult>;
    addNote(_apiKey: string, incidentId: string, content: string, _callerId: string): Promise<PagerDutyResult>;
}
export declare class HttpPagerDutyClient implements PagerDutyClient {
    sendEvent(event: PagerDutyEvent): Promise<PagerDutyResult>;
    addNote(apiKey: string, incidentId: string, content: string, callerId: string): Promise<PagerDutyResult>;
}
//# sourceMappingURL=pagerduty-client.d.ts.map