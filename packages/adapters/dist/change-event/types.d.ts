import type { Change } from '@agentic-obs/common';

/** Generic/custom webhook payload - lowest common denominator format */
export interface GenericWebhookPayload {
    event_type: 'deploy' | 'config' | 'scale' | 'feature_flag';
    service_id: string;
    author?: string;
    description?: string;
    version?: string;
    diff?: string;
    timestamp?: string;
    /** Arbitrary extra fields forwarded as-is */
    [key: string]: unknown;
}

/** GitHub Actions deployment webhook payload (subset of GH API response) */
export interface GitHubDeploymentPayload {
    action: 'created' | 'success' | 'failure' | 'pending';
    deployment: {
        id: number;
        ref: string;
        sha: string;
        environment: string;
        description?: string;
        created_at: string;
        creator: {
            login: string;
        };
    };
    repository: {
        full_name: string;
    };
}

export type WebhookPayload = {
    source: 'generic';
    payload: GenericWebhookPayload;
} | {
    source: 'github';
    payload: GitHubDeploymentPayload;
};

export interface ChangeQuery {
    /** Filter by service ID (exact match) */
    serviceId?: string;
    /** Filter by change type */
    type?: Change['type'];
    startTime: Date;
    endTime: Date;
    /** Max number of results */
    limit?: number;
}
//# sourceMappingURL=types.d.ts.map