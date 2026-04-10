// NotificationClient - interface + stub + formatters for Slack and Teams webhooks

import { randomUUID } from 'crypto';
import { createLogger } from '@agentic-obs/common';

const log = createLogger('notification-client');

// -- Slack types --

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

// -- Teams types --

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

// -- Send result --

export interface NotificationSendResult {
  /** Whether the webhook call succeeded */
  success: boolean;
  /** HTTP status returned by the webhook endpoint (0 for network errors) */
  statusCode: number;
  /** Stub-mode only: the payload that would have been sent */
  preview?: unknown;
  error?: string;
}

// -- Interface --

export interface NotificationClient {
  sendSlack(webhookUrl: string, blocks: SlackBlock[]): Promise<NotificationSendResult>;
  sendTeams(webhookUrl: string, card: TeamsCard): Promise<NotificationSendResult>;
}

// -- Stub implementation --

/** Stub that records calls without making real HTTP requests. */
export class StubNotificationClient implements NotificationClient {
  readonly calls: Array<{ platform: 'slack' | 'teams'; webhookUrl: string; payload: unknown }> = [];

  async sendSlack(webhookUrl: string, blocks: SlackBlock[]): Promise<NotificationSendResult> {
    const payload = { blocks };
    this.calls.push({ platform: 'slack', webhookUrl, payload });
    return { success: true, statusCode: 200, preview: payload };
  }

  async sendTeams(webhookUrl: string, card: TeamsCard): Promise<NotificationSendResult> {
    this.calls.push({ platform: 'teams', webhookUrl, payload: card });
    return { success: true, statusCode: 200, preview: card };
  }
}

// -- Webhook URL validation (SSRF protection) --

const ALLOWED_WEBHOOK_HOSTS = ['hooks.slack.com'];
const ALLOWED_WEBHOOK_PATTERNS = [/^[a-zA-Z0-9]+\.webhook\.office\.com$/];

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^::1$/,
  /^0\./,
  /^localhost$/i,
];

export function validateWebhookUrl(url: string): { valid: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    log.debug({ err }, 'failed to parse webhook URL');
    return { valid: false, reason: 'Invalid URL format' };
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, reason: 'Webhook URL must use HTTPS' };
  }

  const host = parsed.hostname;

  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(host)) {
      return { valid: false, reason: 'Webhook URL must not target internal addresses' };
    }
  }

  if (ALLOWED_WEBHOOK_HOSTS.includes(host)) {
    return { valid: true };
  }
  for (const pattern of ALLOWED_WEBHOOK_PATTERNS) {
    if (pattern.test(host)) {
      return { valid: true };
    }
  }

  return { valid: false, reason: `Webhook host '${host}' is not in the allowed list (hooks.slack.com, *.webhook.office.com).` };
}

const HTTP_TIMEOUT_MS = 30_000;

// -- HTTP implementation --

/** Real implementation that POSTs to Slack/Teams webhook URLs. */
export class HttpNotificationClient implements NotificationClient {
  async sendSlack(webhookUrl: string, blocks: SlackBlock[]): Promise<NotificationSendResult> {
    const validation = validateWebhookUrl(webhookUrl);
    if (!validation.valid) {
      return { success: false, statusCode: 0, error: validation.reason };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks }),
        signal: controller.signal,
      });
      return { success: res.ok, statusCode: res.status };
    } catch (err) {
      return { success: false, statusCode: 0, error: String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  async sendTeams(webhookUrl: string, card: TeamsCard): Promise<NotificationSendResult> {
    const validation = validateWebhookUrl(webhookUrl);
    if (!validation.valid) {
      return { success: false, statusCode: 0, error: validation.reason };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(card),
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

// -- Formatters --

export interface NotificationPayload {
  /** Short title / headline */
  title: string;
  /** Main body text (plain-text or markdown) */
  message: string;
  /** Optional list of key-value context pairs */
  fields?: Array<{ label: string; value: string }>;
  /** Optional severity hint for colour theming */
  severity?: 'info' | 'warning' | 'critical';
}

const TEAMS_SEVERITY_COLOR: Record<string, string> = {
  info: '0076D7',
  warning: 'FFA500',
  critical: 'D13438',
};

/**
 * Build a list of Slack Block Kit blocks from a NotificationPayload.
 *
 * Layout:
 *   [header] title
 *   [section] message
 *   [divider] (only when fields are present)
 *   [section] fields as two-column mrkdwn
 */
export function formatSlackBlocks(payload: NotificationPayload): SlackBlock[] {
  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: payload.title } },
    { type: 'section', text: { type: 'mrkdwn', text: payload.message } },
  ];

  if (payload.fields && payload.fields.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*Details*' },
      fields: payload.fields.map((f) => ({
        type: 'mrkdwn' as const,
        text: `*${f.label}*\n${f.value}`,
      })),
    });
  }

  return blocks;
}

/**
 * Build a Teams MessageCard from a NotificationPayload.
 */
export function formatTeamsCard(payload: NotificationPayload): TeamsCard {
  const themeColor = TEAMS_SEVERITY_COLOR[payload.severity ?? 'info'];

  const sections: TeamsSection[] = [
    {
      activityTitle: payload.title,
      text: payload.message,
      ...(payload.fields && payload.fields.length > 0
        ? { facts: payload.fields.map((f) => ({ name: f.label, value: f.value })) }
        : {}),
    },
  ];

  return {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    summary: payload.title,
    themeColor,
    title: payload.title,
    sections,
  };
}

// Re-export randomUUID for use in notification-adapter
export { randomUUID };