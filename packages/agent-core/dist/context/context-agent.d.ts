import type { StructuredIntent } from '@agentic-obs/common';
import type { TopologyStore } from '@agentic-obs/data-layer';
import type { ChangeEventStore } from '@agentic-obs/adapters';
import type { Agent, AgentContext, AgentResult } from '../index.js';
import type { SystemContext, SloStatusProvider, IncidentProvider } from './types.js';
export interface ContextAgentDeps {
    topologyStore: TopologyStore;
    changeEventStore: ChangeEventStore;
    sloProvider?: SloStatusProvider;
    incidentProvider?: IncidentProvider;
    changeLookbackMs?: number;
}
export declare class ContextAgent implements Agent<StructuredIntent, SystemContext> {
    readonly name = "context";
    private readonly topology;
    private readonly changes;
    private readonly sloProvider?;
    private readonly incidentProvider?;
    private readonly changeLookbackMs;
    constructor(deps: ContextAgentDeps);
    run(input: StructuredIntent, _context: AgentContext): Promise<AgentResult<SystemContext>>;
    private collect;
    private resolveEntityId;
    private collectTopology;
    private collectChanges;
    private collectSloStatus;
    private collectIncidents;
    private deriveWindow;
}
//# sourceMappingURL=context-agent.d.ts.map