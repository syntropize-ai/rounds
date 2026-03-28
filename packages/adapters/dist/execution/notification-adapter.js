import { randomUUID } from 'crypto';
import { HttpNotificationClient, formatSlackBlocks, formatTeamsCard } from './notification-client.js';

const CAPABILITY = 'send_notification';
const VALID_PLATFORMS = ['slack', 'teams'];

export class NotificationAdapter {
    client;
    constructor(client = new HttpNotificationClient()) {
        this.client = client;
    }
    capabilities() {
        return [CAPABILITY];
    }
    async validate(action) {
        const params = action.params;
        if (!params.channel || typeof params.channel !== 'string' || params.channel.trim() === '') {
            return { valid: false, reason: "'channel' is required and must be a non-empty string" };
        }
        if (!params.message || typeof params.message !== 'string' || params.message.trim() === '') {
            return { valid: false, reason: "'message' is required and must be a non-empty string" };
        }
        if (!params.platform || !VALID_PLATFORMS.includes(params.platform)) {
            return { valid: false, reason: ` 'platform' must be one of: ${VALID_PLATFORMS.join(', ')}` };
        }
        return { valid: true };
    }
    async dryRun(action) {
        const params = action.params;
        const platform = params.platform ?? 'slack';
        const title = params.title ?? action.targetService ?? 'Notification';
        let preview;
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
            ...{ preview },
        };
    }
    async execute(action) {
        const params = action.params;
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
            return {
                success: false,
                output: null,
                rollbackable: false,
                executionId,
                error: 'Notification delivery failed due to an internal error',
            };
        }
    }
}