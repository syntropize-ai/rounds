// Alert Rule - user-defined or LLM-generated monitoring condition

export type AlertRuleState = 'normal' | 'pending' | 'firing' | 'resolved' | 'disabled';
export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';
export type AlertOperator = '>' | '>=' | '<' | '<=' | '==' | '!=';

export interface AlertCondition {
  query: string; // PromQL expression
  operator: AlertOperator;
  threshold: number;
  forDurationSec: number; // Must satisfy condition for this long before firing (0 = immediate)
}

export interface AlertRule {
  id: string;
  name: string;
  description: string;
  originalPrompt?: string; // Natural language that generated this rule

  condition: AlertCondition;
  evaluationIntervalSec: number; // How often to evaluate (default 60)

  severity: AlertSeverity;
  labels?: Record<string, string>; // Free-form labels for routing/grouping/silencing
  state: AlertRuleState;
  stateChangedAt: string;
  pendingSince?: string;

  // Notification
  notificationPolicyId?: string;

  // Investigation link
  investigationId?: string; // Report ID from auto/manual investigation

  // Workspace
  workspaceId?: string;

  // Metadata
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastEvaluatedAt?: string;
  lastFiredAt?: string;
  fireCount: number;
}

export interface AlertHistoryEntry {
  id: string;
  ruleId: string;
  ruleName: string;
  fromState: AlertRuleState;
  toState: AlertRuleState;
  value: number;
  threshold: number;
  timestamp: string;
  labels: Record<string, string>;
}

export interface NotificationPolicy {
  id: string;
  name: string;
  matchers: Array<{
    label: string;
    operator: '=' | '!=' | '=~' | '!~';
    value: string;
  }>;
  channels: Array<{
    type: 'slack' | 'teams' | 'pagerduty' | 'webhook';
    config: Record<string, string>;
  }>;
  groupBy?: string[];
  groupWaitSec?: number;
  groupIntervalSec?: number;
  repeatIntervalSec?: number;
  createdAt: string;
  updatedAt: string;
}

export interface AlertSilence {
  id: string;
  matchers: Array<{
    label: string;
    operator: '=' | '!=' | '=~' | '!~';
    value: string;
  }>;
  startsAt: string;
  endsAt: string;
  comment: string;
  createdBy: string;
  createdAt: string;
  status?: SilenceStatus;
}

// Contact Points
export type ContactPointIntegrationType =
  | 'slack'
  | 'email'
  | 'pagerduty'
  | 'webhook'
  | 'teams'
  | 'opsgenie'
  | 'telegram'
  | 'discord';

export interface ContactPointIntegration {
  id: string;
  type: ContactPointIntegrationType;
  name: string; // display name for this integration
  settings: Record<string, string>; // type-specific config
  disableResolveMessage?: boolean;
}

export interface ContactPoint {
  id: string;
  name: string; // E.g. "Prod On-Call", "Slack #incidents"
  integrations: ContactPointIntegration[];
  createdAt: string;
  updatedAt: string;
}

// Notification Policy Tree
export interface NotificationPolicyNode {
  id: string;
  matchers: Array<{
    label: string;
    operator: '=' | '!=' | '=~' | '!~';
    value: string;
  }>;
  contactPointId: string; // reference to ContactPoint.id
  groupBy?: string[]; // labels to group alerts by
  groupWaitSec?: number; // wait before sending first notification for new group (default 30)
  groupIntervalSec?: number; // wait before sending subsequent notifications for same group (default 300)
  repeatIntervalSec?: number; // wait before re-sending same notification (default 3600)
  continueMatching?: boolean; // if true, continue to sibling policies after match
  muteTimingIds?: string[]; // reference to MuteTiming.id
  children: NotificationPolicyNode[]; // nested child policies
  isDefault?: boolean; // true for root policy only
  createdAt: string;
  updatedAt: string;
}

// Mute Timings
export interface TimeInterval {
  timesOfDay?: Array<{ startMinute: number; endMinute: number }>; // minutes from midnight
  weekdays?: number[]; // 0=Sunday, 1=Monday, ..., 6=Saturday
  daysOfMonth?: number[]; // 1-31, negative for from end
  months?: number[]; // 1-12
  years?: number[]; // e.g. [2024, 2025]
  location?: string; // IANA timezone, default UTC
}

export interface MuteTiming {
  id: string;
  name: string; // e.g. "Weekends", "Maintenance Window"
  timeIntervals: TimeInterval[];
  createdAt: string;
  updatedAt: string;
}

// Alert Groups
export interface AlertGroup {
  labels: Record<string, string>; // the group-by label values
  alerts: Array<{
    ruleId: string;
    ruleName: string;
    state: AlertRuleState;
    severity?: AlertSeverity;
    labels: Record<string, string>;
    value?: number;
    startsAt: string;
    annotations?: Record<string, string>;
  }>;
}

// Enhanced Silence
export type SilenceStatus = 'active' | 'expired' | 'pending';

// Alert Rule Provider interface - used by alert evaluator and data stores
export interface AlertRuleProvider {
  getActiveRules(): AlertRule[];
  transition(id: string, newState: AlertRuleState, value?: number): AlertRule | undefined;
  markEvaluated(id: string): void;
}
