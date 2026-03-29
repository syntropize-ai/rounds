import type { PanelConfig, DashboardVariable } from '@agentic-obs/common';
import type { GeneratorDeps } from './types.js';
export interface PanelAdderInput {
    goal: string;
    existingPanels: PanelConfig[];
    existingVariables: DashboardVariable[];
    availableMetrics: string[];
    labelsByMetric: Record<string, string[]>;
    gridNextRow: number;
}
export interface PanelAdderOutput {
    panels: PanelConfig[];
    variables?: DashboardVariable[];
}
export declare class PanelAdderAgent {
    private deps;
    constructor(deps: GeneratorDeps);
    addPanels(input: PanelAdderInput): Promise<PanelAdderOutput>;
    private generate;
    private critique;
    private toPanelConfigs;
    private detectNewVariables;
}
//# sourceMappingURL=panel-adder-agent.d.ts.map
