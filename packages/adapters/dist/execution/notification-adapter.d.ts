import type { ExecutionAdapter, AdapterAction, AdapterCapability, ValidationResult, DryRunResult, ExecutionResult } from '@agentic-obs/agent-core';
import type { NotificationClient } from './notification-client.js';

export type NotificationPlatform = 'slack' | 'teams';

export interface NotificationParams {
    /** Target channel name or description (informational) */
    channel: string;
    /** Message body */
    message: string;
    /** Notification platform */
    platform: NotificationPlatform;
    /** Optional title (defaults to action.targetService) */
    title?: string;
    /** Optional key-value context fields to include in the message */
    fields?: Array<{
        label: string;
        value: string;
    }>;
    /** Optional severity hint */
    severity?: 'info' | 'warning' | 'critical';
    /** Webhook URL, populated by CredentialResolver */
    webhookUrl?: string;
}

export declare class NotificationAdapter implements ExecutionAdapter {
    private readonly client;
    constructor(client?: NotificationClient);
    capabilities(): AdapterCapability[];
    validate(action: AdapterAction): Promise<ValidationResult>;
    dryRun(action: AdapterAction): Promise<DryRunResult>;
    execute(action: AdapterAction): Promise<ExecutionResult>;
}