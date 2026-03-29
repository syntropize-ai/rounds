import type { PanelConfig, DashboardVariable } from '@agentic-obs/common';
export interface DashboardPlan {
    title: string;
    description: string;
    groups: PanelGroup[];
    variables: VariableSuggestion[];
}
export interface PanelGroup {
    id: string;
    label: string;
    purpose: string;
    panelSpecs: PanelSpec[];
}
export interface PanelSpec {
    title: string;
    description: string;
    visualization: string;
    queryIntent: string;
    width: number;
    height: number;
}
export interface VariableSuggestion {
    name: string;
    label: string;
    purpose: string;
}
export interface CriticFeedback {
    approved: boolean;
    overallScore: number;
    issues: CriticIssue[];
}
export interface CriticIssue {
    panelTitle: string;
    severity: 'error' | 'warning';
    category: string;
    description: string;
    suggestedFix?: string;
}
export interface RawPanelSpec {
    title: string;
    description: string;
    visualization: string;
    queries: Array<{
        refId: string;
        expr: string;
        legendFormat?: string;
        instant?: boolean;
    }>;
    row: number;
    col: number;
    width: number;
    height: number;
    unit?: string;
    stackMode?: 'none' | 'normal' | 'percent';
    fillOpacity?: number;
    decimals?: number;
    thresholds?: Array<{
        value: number;
        color: string;
        label?: string;
    }>;
}
export interface GeneratorDeps {
    gateway: import('@agentic-obs/llm-gateways').LLMGateway;
    model: string;
    prometheusUrl: string | undefined;
    prometheusHeaders: Record<string, string>;
    sendEvent: (event: import('@agentic-obs/common').DashboardSSEEvent) => void;
}
export interface GenerateInput {
    goal: string;
    scope: 'single' | 'group' | 'comprehensive';
    existingPanels: PanelConfig[];
    existingVariables: DashboardVariable[];
}
export interface GenerateOutput {
    title: string;
    description: string;
    panels: PanelConfig[];
    variables: DashboardVariable[];
}
//# sourceMappingURL=types.d.ts.map
