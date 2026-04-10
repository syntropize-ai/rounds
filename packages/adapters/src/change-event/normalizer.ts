// Normalize webhook payloads from various sources into the common Change model

import { randomUUID } from 'node:crypto';
import type { Change } from '@agentic-obs/common';
import type { WebhookPayload, GenericWebhookPayload, GitHubDeploymentPayload } from './types.js';

function generateId(): string {
  return `chg_${randomUUID()}`;
}

function normalizeGeneric(payload: GenericWebhookPayload): Change {
  return {
    id: generateId(),
    serviceId: payload.service_id,
    type: payload.event_type,
    timestamp: payload.timestamp ?? new Date().toISOString(),
    author: payload.author ?? 'unknown',
    description: payload.description ?? `${payload.event_type} event`,
    version: payload.version,
    diff: payload.diff,
  };
}

function normalizeGitHub(payload: GitHubDeploymentPayload): Change | null {
  // Only ingest terminal or created states, not every intermediate state
  if (payload.action === 'pending') return null;

  return {
    id: generateId(),
    serviceId: payload.repository.full_name,
    type: 'deploy',
    timestamp: payload.deployment.created_at,
    author: payload.deployment.creator.login,
    description:
      payload.deployment.description ??
      `Deploy ${payload.deployment.ref} to ${payload.deployment.environment}`,
    version: payload.deployment.sha,
  };
}

/**
 * Normalize a webhook payload into a Change object.
 * Returns null if the payload should be ignored (e.g. pending GitHub deployments).
 */
export function normalizeWebhook(event: WebhookPayload): Change | null {
  switch (event.source) {
    case 'generic':
      return normalizeGeneric(event.payload);
    case 'github':
      return normalizeGitHub(event.payload);
  }
}