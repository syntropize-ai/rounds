import type { ContactPointIntegration } from '@agentic-obs/common';
import type { AlertFiredEventPayload } from '@agentic-obs/common/events';

export type { AlertFiredEventPayload };

export interface SenderResult {
  ok: boolean;
  message: string;
}

export type Sender = (
  integration: ContactPointIntegration,
  payload: AlertFiredEventPayload,
) => Promise<SenderResult>;
