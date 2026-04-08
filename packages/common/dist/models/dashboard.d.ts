import type { PublishStatus } from './version.js';
export type PanelVisualization = 'time_series' | 'stat' | 'table' | 'gauge' | 'bar' | 'heatmap' | 'pie' | 'histogram' | 'status_timeline';
export type DashboardStatus = 'generating' | 'ready' | 'failed';
export interface PanelQuery {
    refId: string;
    expr: string;
    legendFormat?: string;
    instant?: boolean;
    datasourceId?: string;
}
export interface PanelThreshold {
    value: number;
    color: string;
    label?: string;
}
/** Point-in-time data captured during an investigation, so panels render
 *  the exact data that was observed rather than live queries. */
export interface PanelSnapshotData {
    /** For range visualizations (time_series, heatmap, status_timeline) */
    range?: Array<{
        refId: string;
        legendFormat?: string;
        series: Array<{
            labels: Record<string, string>;
            points: Array<{
                ts: number;
                value: number;
            }>;
        }>;
        totalSeries: number;
    }>;
    /** For instant visualizations (stat, gauge, bar, pie, histogram) */
    instant?: {
        data: {
            result: Array<{
                metric: Record<string, string>;
                value: [number, string];
            }>;
        };
    };
    /** ISO timestamp when the data was captured */
    capturedAt: string;
}
export interface PanelConfig {
    id: string;
    title: string;
    description: string;
    queries?: PanelQuery[];
    visualization: PanelVisualization;
    row: number;
    col: number;
    width: number;
    height: number;
    refreshIntervalSec?: number | null;
    unit?: string;
    thresholds?: PanelThreshold[];
    stackMode?: 'none' | 'normal' | 'percent';
    fillOpacity?: number;
    decimals?: number;
    query?: string;
    sectionId?: string;
    sectionLabel?: string;
    /** Static snapshot data captured during investigation — when set, panel
     *  renders this data instead of executing live PromQL queries. */
    snapshotData?: PanelSnapshotData;
}
export interface DashboardVariable {
    name: string;
    label: string;
    type: 'query' | 'custom' | 'datasource';
    query?: string;
    options?: string[];
    current?: string;
    multi?: boolean;
    includeAll?: boolean;
}
export interface DashboardMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    actions?: DashboardAction[];
    timestamp: string;
}
export type DashboardAction = {
    type: 'add_panels';
    panels: PanelConfig[];
} | {
    type: 'remove_panels';
    panelIds: string[];
} | {
    type: 'modify_panel';
    panelId: string;
    patch: Partial<PanelConfig>;
} | {
    type: 'rearrange';
    layout: Array<{
        panelId: string;
        row: number;
        col: number;
        width: number;
        height: number;
    }>;
} | {
    type: 'add_variable';
    variable: DashboardVariable;
} | {
    type: 'set_title';
    title: string;
    description?: string;
} | {
    type: 'create_alert_rule';
    ruleId: string;
    name: string;
    severity: string;
    query: string;
    operator: string;
    threshold: number;
    forDurationSec: number;
    evaluationIntervalSec: number;
} | {
    type: 'modify_alert_rule';
    ruleId: string;
    patch: {
        threshold?: number;
        operator?: string;
        severity?: string;
        forDurationSec?: number;
        evaluationIntervalSec?: number;
        query?: string;
        name?: string;
    };
} | {
    type: 'delete_alert_rule';
    ruleId: string;
    name?: string;
};
export interface InvestigationReportSection {
    type: 'text' | 'evidence';
    content: string;
    panel?: PanelConfig;
}
export interface InvestigationReport {
    summary: string;
    sections: InvestigationReportSection[];
}
export interface SavedInvestigationReport {
    id: string;
    dashboardId: string;
    goal: string;
    summary: string;
    sections: InvestigationReportSection[];
    createdAt: string;
}
export type DashboardSseEvent = {
    type: 'thinking';
    content: string;
} | {
    type: 'tool_call';
    tool: string;
    args: Record<string, unknown>;
    displayText: string;
} | {
    type: 'tool_result';
    tool: string;
    summary: string;
    success: boolean;
} | {
    type: 'panel_added';
    panel: PanelConfig;
} | {
    type: 'panel_removed';
    panelId: string;
} | {
    type: 'panel_modified';
    panelId: string;
    patch: Partial<PanelConfig>;
} | {
    type: 'variable_added';
    variable: DashboardVariable;
} | {
    type: 'investigation_report';
    report: InvestigationReport;
} | {
    type: 'verification_report';
    report: {
        status: string;
        targetKind: string;
        summary: string;
        issues: Array<{
            code: string;
            severity: string;
            message: string;
            artifactKind: string;
            artifactId?: string;
        }>;
        checksRun: string[];
    };
} | {
    type: 'reply';
    content: string;
} | {
    type: 'done';
    messageId: string;
} | {
    type: 'error';
    message: string;
};
export type DashboardType = 'dashboard';
export interface Dashboard {
    id: string;
    type: DashboardType;
    title: string;
    description: string;
    prompt: string;
    userId: string;
    status: DashboardStatus;
    panels: PanelConfig[];
    variables: DashboardVariable[];
    refreshIntervalSec: number;
    datasourceIds: string[];
    useExistingMetrics: boolean;
    folder?: string;
    workspaceId?: string;
    version?: number;
    publishStatus?: PublishStatus;
    createdAt: string;
    updatedAt: string;
    error?: string;
}
//# sourceMappingURL=dashboard.d.ts.map