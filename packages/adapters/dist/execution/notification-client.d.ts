import { randomUUID } from 'crypto';

export interface SlackTextObject {
    type: 'plain_text' | 'mrkdwn';
    text: string;
}
export interface SlackSectionBlock {
    type: 'section';
    text: SlackTextObject;
    fields?: SlackTextObject[];
}
export interface SlackDividerBlock {
    type: 'divider';
}
export interface SlackHeaderBlock {
    type: 'header';
    text: SlackTextObject;
}
export type SlackBlock = SlackSectionBlock | SlackDividerBlock | SlackHeaderBlock;
export interface TeamsFactEntry {
    name: string;
    value: string;
}
export interface TeamsSection {
    activityTitle?: string;
    activitySubtitle?: string;
    facts?: TeamsFactEntry[];
    text?: string;
}
export interface TeamsCard {
    '@type': 'MessageCard';
    '@context': 'https://schema.org/extensions';
    summary: string;
    themeColor?: string;
    title: string;
    sections?: TeamsSection[];
}
export interface NotificationSendResult {
    /** Whether the webhook call succeeded */
    success: boolean;
    /** HTTP status returned by the webhook endpoint (0 for network errors) */
    statusCode: number;
    /** Stub-mode only: the payload that would have been sent */
    preview?: unknown;
    error?: string;
}
export interface NotificationClient {
    sendSlack(webhookUrl: string, blocks: SlackBlock[]): Promise<NotificationSendResult>;
    sendTeams(webhookUrl: string, card: TeamsCard): Promise<NotificationSendResult>;
}
/** Stub that records calls without making real HTTP requests. */
export declare class StubNotificationClient implements NotificationClient {
    readonly calls: Array<{
        platform: 'slack' | 'teams';
        webhookUrl: string;
        payload: unknown;
    }>;
    sendSlack(webhookUrl: string, blocks: SlackBlock[]): Promise<NotificationSendResult>;
    sendTeams(webhookUrl: string, card: TeamsCard): Promise<NotificationSendResult>;
}
export declare function validateWebhookUrl(url: string): {
    valid: boolean;
    reason?: string;
};
/** Real implementation that POSTs to Slack/Teams webhook URLs. */
export declare class HttpNotificationClient implements NotificationClient {
    sendSlack(webhookUrl: string, blocks: SlackBlock[]): Promise<NotificationSendResult>;
    sendTeams(webhookUrl: string, card: TeamsCard): Promise<NotificationSendResult>;
}
export interface NotificationPayload {
    /** Short title / headline */
    title: string;
    /** Main body text (plain-text or markdown) */
    message: string;
    /** Optional list of key-value context pairs */
    fields?: Array<{
        label: string;
        value: string;
    }>;
    /** Optional severity hint for colour theming */
    severity?: 'info' | 'warning' | 'critical';
}
/**
 * Build a list of Slack Block Kit blocks from a NotificationPayload.
 *
 * Layout:
 *   [header] title
 *   [section] message
 *   [divider]  (only when fields are present)
 *   [section]  fields as two-column mrkdwn
 */
export declare function formatSlackBlocks(payload: NotificationPayload): SlackBlock[];
/**
 * Build a Teams MessageCard from a NotificationPayload.
 */
export declare function formatTeamsCard(payload: NotificationPayload): TeamsCard;
export { randomUUID };
//# sourceMappingURL=notification-client.d.ts.map