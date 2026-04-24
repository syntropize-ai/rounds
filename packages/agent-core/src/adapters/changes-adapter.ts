/**
 * Source-agnostic change-event adapter interface.
 *
 * A "change" is anything that may explain a metric/log anomaly: deploys,
 * config rollouts, feature-flag flips, manually logged incidents, etc.
 * Concrete implementations live outside agent-core (e.g. the existing
 * change-event adapter in @agentic-obs/adapters, future Argo/GitHub/Statuspage
 * adapters, etc.).
 */

export type ChangeKind =
  | 'deploy'
  | 'config'
  | 'feature-flag'
  | 'incident'
  | 'other';

export interface ChangeRecord {
  id: string;
  service: string;
  kind: ChangeKind;
  summary: string;
  /** ISO-8601 timestamp when the change took effect. */
  at: string;
  metadata?: Record<string, unknown>;
}

export interface ChangesListInput {
  /** Optional service filter. Omit to fetch across all services. */
  service?: string;
  /** Look back this many minutes from now. */
  windowMinutes: number;
}

export interface IChangesAdapter {
  listRecent(input: ChangesListInput): Promise<ChangeRecord[]>;
}
