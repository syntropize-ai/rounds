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
    type: 'reply';
    content: string;
} | {
    type: 'done';
    messageId: string;
} | {
    type: 'error';
    message: string;
};
export type DashboardType = 'dashboard' | 'investigation';
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
    createdAt: string;
    updatedAt: string;
    error?: string;
}
//# sourceMappingURL=dashboard.d.ts.map