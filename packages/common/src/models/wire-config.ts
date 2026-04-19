/**
 * HTTP wire-format types for instance-scoped config endpoints.
 *
 * These are the shapes that cross the HTTP boundary between the web
 * frontend and the api-gateway — single source of truth for what
 * `/api/system/llm`, `/api/system/notifications`, `/api/setup/llm/test`,
 * and `/api/setup/config` accept and return.
 *
 * Deliberately distinct from the storage models in
 * `./instance-config.ts`:
 *
 *   - Storage models use nullable fields (`string | null`) because
 *     SQLite columns are nullable. Wire shapes use optional fields
 *     (`string | undefined`) because JSON serialization elides
 *     `undefined` but preserves `null`, and most HTTP clients prefer
 *     "field absent" over "field is null".
 *   - Storage models carry `updatedAt` / `updatedBy` audit columns.
 *     The wire shape for writes doesn't include them (server fills in).
 *
 * Frontend form state lives next to each page (e.g. `LlmConfig` in
 * `packages/web/src/pages/setup/types.ts`) and carries additional
 * purely-client concerns like "I am currently testing this config" —
 * those never leave the browser and have no place here.
 *
 * BOUNDARY: this file is imported from the web bundle. Keep it free of
 * Node-only types.
 */

import type { LlmProvider, LlmAuthType } from './instance-config.js';

// -- LLM wire format ----------------------------------------------------

/**
 * Request body for `PUT /api/system/llm` (save) and
 * `POST /api/setup/llm/test` (test-only). Also the shape of the `llm`
 * field in the `GET /api/setup/config` response — with the caveat that
 * the server returns a masked `apiKey` (e.g. "••••••abcd") in the read
 * response and expects the real key on write.
 */
export interface LlmConfigWire {
  provider: LlmProvider;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  region?: string;
  authType?: LlmAuthType;
}

// -- Notification channel wire format ----------------------------------

/**
 * Per-channel wire shapes. Shape of each field is stable across
 * `PUT /api/system/notifications` (write) and
 * `GET /api/setup/config → notifications` (read, secrets masked).
 */
export interface SlackChannelWire {
  webhookUrl: string;
}

export interface PagerDutyChannelWire {
  integrationKey: string;
}

export interface EmailChannelWire {
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
}

/**
 * Top-level notification payload. Each channel is optional; include only
 * those you want to save. Missing channels on a PUT are interpreted as
 * "remove" by the server (see `routes/system.ts`).
 */
export interface NotificationsWire {
  slack?: SlackChannelWire;
  pagerduty?: PagerDutyChannelWire;
  email?: EmailChannelWire;
}
