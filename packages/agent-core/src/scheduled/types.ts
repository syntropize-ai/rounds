// Scheduled Investigation types

export type InvestigationDepth = 'quick' | 'thorough';

export interface ScheduleConfig {
  /** Unique schedule ID (auto-assigned if omitted) */
  id?: string;
  /** The service being monitored */
  serviceId: string;
  /** Cron expression, e.g. '0 * * * *' = every hour */
  cron: string;
  /** How deeply to investigate if the LLM decides it's worth it */
  depth: InvestigationDepth;
  /** Human-readable description shown to the LLM for context */
  description: string;
  /** Tenant scope */
  tenantId?: string;
  /** Whether the schedule is currently active (default: true) */
  enabled?: boolean;
}

export interface ScheduleRecord extends Required<ScheduleConfig> {
  createdAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export interface ScheduledJobData {
  scheduleId: string;
  serviceId: string;
  depth: InvestigationDepth;
  description: string;
  tenantId: string;
}

// Outcome written to feed
export interface ScheduledRunOutcome {
  scheduleId: string;
  serviceId: string;
  ranAt: string;
  decision: 'investigate' | 'all_clear' | 'skipped_llm_unavailable';
  investigationId?: string;
  reason: string;
}

// LLM response shape
export interface LLMCheckResponse {
  shouldInvestigate: boolean;
  reason: string;
}
