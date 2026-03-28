import type { StructuredIntent } from '@agentic-obs/common';

export interface IntentInput {
  /** Natural-language message from the user. */
  message: string;
  /** Optional session context. */
  sessionId?: string;
}

export type { StructuredIntent };
