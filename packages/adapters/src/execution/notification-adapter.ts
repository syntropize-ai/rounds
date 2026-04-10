// NotificationAdapter - ExecutionAdapter implementation for Slack / Teams webhooks

import { randomUUID } from 'crypto';
import { createLogger } from '@agentic-obs/common';

const log = createLogger('notification-adapter');
import type {
  ExecutionAdapter,
  AdapterAction,
  AdapterCapability,
  ValidationResult,
  DryRunResult,
  ExecutionResult,
} from './types.js';
import type { NotificationClient } from './notification-client.js';
import {
  HttpNotificationClient,
  formatSlackBlocks,
  formatTeamsCard,
} from './notification-client.js';

// -- Param types --

export type NotificationPlatform = 'slack' | 'teams';

/**
 * Expected `action.params` shape for `send_notification` actions.
 * `credential` (from `action.credentialRef` resolution) carries the webhook URL.
 */
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
  fields?: Array<{ label: string; value: string }>;
  /** Optional severity hint */
  severity?: 'info' | 'warning' | 'critical';
  /**
   * Webhook URL.
   * Populated by CredentialResolver from `action.credentialRef`,
   * or supplied directly in params for testing.
   */
  webhookUrl?: string;
}

const CAPABILITY = 'send_notification';
const VALID_PLATFORMS: NotificationPlatform[] = ['slack', 'teams'];

// -- Adapter --

export class NotificationAdapter implements ExecutionAdapter {
  private readonly client: NotificationClient;

  constructor(client: NotificationClient = new HttpNotificationClient()) {
    this.client = client;
  }

  capabilities(): AdapterCapability[] {
    return [CAPABILITY];
  }

  async validate(action: AdapterAction): Promise<ValidationResult> {
    const params = action.params as Partial<NotificationParams>;

    if (!params.channel || typeof params.channel !== 'string' || params.channel.trim() === '') {
      return { valid: false, reason: '`channel` is required and must be a non-empty string' };
    }
    if (!params.message || typeof params.message !== 'string' || params.message.trim() === '') {
      return { valid: false, reason: '`message` is required and must be a non-empty string' };
    }
    if (!params.platform || !VALID_PLATFORMS.includes(params.platform as NotificationPlatform)) {
      return { valid: false, reason: `\`platform\` must be one of: ${VALID_PLATFORMS.join(', ')}` };
    }

    return { valid: true };
  }

  async dryRun(action: AdapterAction): Promise<DryRunResult> {
    const params = action.params as unknown as NotificationParams;
    const platform = params.platform ?? 'slack';
    const title = params.title ?? action.targetService ?? 'Notification';

    let preview: unknown;
    if (platform === 'slack') {
      preview = formatSlackBlocks({
        title,
        message: params.message,
        fields: params.fields,
        severity: params.severity,
      });
    } else {
      preview = formatTeamsCard({
        title,
        message: params.message,
        fields: params.fields,
        severity: params.severity,
      });
    }

    return {
      estimatedImpact: `Send ${platform} notification to channel "${params.channel}": "${params.message.slice(0, 60)}${params.message.length > 60 ? '...' : ''}"`,
      warnings: [],
      willAffect: [params.channel],
      // Attach preview as extra metadata (not in DryRunResult type, but accessible via spread)
      ...({ preview } as object),
    } as unknown as DryRunResult & { preview: unknown };
  }

  async execute(action: AdapterAction): Promise<ExecutionResult> {
    const params = action.params as unknown as NotificationParams;
    const executionId = randomUUID();

    const webhookUrl = params.webhookUrl;
    if (!webhookUrl || typeof webhookUrl !== 'string' || webhookUrl.trim() === '') {
      return {
        success: false,
        output: null,
        rollbackable: false,
        executionId,
        error: 'webhookUrl is required in params (populated by CredentialResolver)',
      };
    }

    const title = params.title ?? action.targetService ?? 'Notification';
    const payload = { title, message: params.message, fields: params.fields, severity: params.severity };

    try {
      let result;
      if (params.platform === 'slack') {
        result = await this.client.sendSlack(webhookUrl, formatSlackBlocks(payload));
      } else {
        result = await this.client.sendTeams(webhookUrl, formatTeamsCard(payload));
      }

      if (!result.success) {
        return {
          success: false,
          output: result,
          rollbackable: false,
          executionId,
          error: result.error ?? `Webhook returned HTTP ${result.statusCode}`,
        };
      }

      return {
        success: true,
        output: { platform: params.platform, channel: params.channel, statusCode: result.statusCode },
        rollbackable: false,
        executionId,
      };
    } catch (err) {
      log.warn({ err }, 'notification delivery failed');
      return {
        success: false,
        output: null,
        rollbackable: false,
        executionId,
        error: 'Notification delivery failed due to an internal error',
      };
    }
  }

  // rollback is intentionally undefined - notifications cannot be recalled
}