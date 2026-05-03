import type { Sender } from './types.js';
import { postWebhook, buildAlertWebhookBody } from './webhook-fetch.js';

export const webhookSender: Sender = async (integration, payload) =>
  postWebhook(integration, buildAlertWebhookBody(payload));
