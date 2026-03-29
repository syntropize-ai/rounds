import type { PanelConfig } from '@agentic-obs/common';
import type { GeneratorDeps, GenerateInput, GenerateOutput } from './types.js';
export declare class DashboardGeneratorAgent {
    private deps;
    private readonly researchAgent;
    constructor(deps: GeneratorDeps);
    generate(input: GenerateInput, onGroupComplete?: (panels: PanelConfig[]) => void | Promise<void>): Promise<GenerateOutput>;
    private selectRelevantMetrics;
    private plan;
    private generateAndCriticLoop;
    private generateGroup;
    private critique;
    private toPanelConfigs;
    private validateQueries;
    private queryPrometheus;
    private detectVariables;
}
//# sourceMappingURL=dashboard-generator-agent.d.ts.map
