export type AlertRuleState = 'normal' | 'pending' | 'firing' | 'resolved' | 'disabled';
export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';
export type AlertOperator = '>' | '>=' | '<' | '<=' | '==' | '!=';
export interface AlertCondition {
    query: string;
    operator: AlertOperator;
    threshold: number;
    forDurationSec: number;
}
export interface AlertRule {
    id: string;
    name: string;
    description: string;
    originalPrompt?: string;
    condition: AlertCondition;
    evaluationIntervalSec: number;
    severity: AlertSeverity;
    labels?: Record<string, string>;
    state: AlertRuleState;
    stateChangedAt: string;
    pendingSince?: string;
    notificationPolicyId?: string;
    investigationId?: string;
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
export type ContactPointIntegrationType = 'slack' | 'email' | 'pagerduty' | 'webhook' | 'teams' | 'opsgenie' | 'telegram' | 'discord';
export interface ContactPointIntegration {
    id: string;
    type: ContactPointIntegrationType;
    name: string;
    settings: Record<string, string>;
    disableResolveMessage?: boolean;
}
export interface ContactPoint {
    id: string;
    name: string;
    integrations: ContactPointIntegration[];
    createdAt: string;
    updatedAt: string;
}
export interface NotificationPolicyNode {
    id: string;
    matchers: Array<{
        label: string;
        operator: '=' | '!=' | '=~' | '!~';
        value: string;
    }>;
    contactPointId: string;
    groupBy?: string[];
    groupWaitSec?: number;
    groupIntervalSec?: number;
    repeatIntervalSec?: number;
    continueMatching?: boolean;
    muteTimingIds?: string[];
    children: NotificationPolicyNode[];
    isDefault?: boolean;
    createdAt: string;
    updatedAt: string;
}
export interface TimeInterval {
    timesOfDay?: Array<{
        startMinute: number;
        endMinute: number;
    }>;
    weekdays?: number[];
    daysOfMonth?: number[];
    months?: number[];
    years?: number[];
    location?: string;
}
export interface MuteTiming {
    id: string;
    name: string;
    timeIntervals: TimeInterval[];
    createdAt: string;
    updatedAt: string;
}
export interface AlertGroup {
    labels: Record<string, string>;
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
export type SilenceStatus = 'active' | 'expired' | 'pending';
//# sourceMappingURL=alert.d.ts.map