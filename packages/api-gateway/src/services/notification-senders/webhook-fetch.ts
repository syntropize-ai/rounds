import { ensureSafeUrl } from '../../utils/url-validator.js';
import type { ContactPointIntegration } from '@agentic-obs/common';
import type { SenderResult, AlertFiredEventPayload } from './types.js';

export function extractWebhookUrl(settings: Record<string, string> | undefined): string {
  return settings?.['url'] ?? settings?.['webhookUrl'] ?? '';
}

/**
 * Build the JSON body POSTed to slack/discord/teams/generic webhooks.
 * Matches the test-button shape in routes/notifications.ts.
 */
export function buildAlertWebhookBody(
  payload: AlertFiredEventPayload,
): { text: string; username: string } {
  const labelsBit = Object.entries(payload.labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  const text =
    `[${payload.severity.toUpperCase()}] ${payload.ruleName} firing — `
    + `value ${payload.value} ${payload.operator} ${payload.threshold}`
    + (labelsBit ? ` (${labelsBit})` : '');
  return { text, username: 'Agentic Obs' };
}

/**
 * Build the JSON body for the test-button POST. Kept here so the route and
 * the production consumer don't drift.
 */
export function buildTestWebhookBody(
  contactPointName: string,
): { text: string; username: string } {
  return {
    text: `Test notification from OpenObs - contact point "${contactPointName}" is working correctly.`,
    username: 'Agentic Obs',
  };
}

/**
 * Shared POST helper used by slack/discord/teams/webhook senders. Resolves
 * the URL safely (same SSRF posture as the test-button), POSTs JSON with a
 * 10s abort, and translates errors into a SenderResult.
 */
export async function postWebhook(
  integration: ContactPointIntegration,
  body: unknown,
): Promise<SenderResult> {
  const url = extractWebhookUrl(integration.settings);
  if (!url) {
    return { ok: false, message: 'No webhook URL configured' };
  }
  try {
    const safeUrl = await ensureSafeUrl(url);
    const resp = await fetch(safeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return {
      ok: resp.ok,
      message: resp.ok ? 'Notification sent successfully' : `HTTP ${resp.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
