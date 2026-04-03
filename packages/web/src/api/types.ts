// Re-export canonical domain types from the shared common package.
// Do NOT re-define these locally - use the single source of truth.
export type {
  Investigation,
  InvestigationStatus,
  Evidence,
  ApiError,
} from '@agentic-obs/common';

// Web-specific wrapper types

export interface ApiResponse<T> {
  data: T;
  error?: import('@agentic-obs/common').ApiError;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

export interface FeedEvent {
  id: string;
  type: 'anomaly' | 'agent' | 'info' | 'error';
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface SSEMessage<T = unknown> {
  event: string;
  data: T;
}
