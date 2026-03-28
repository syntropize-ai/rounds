import type { StructuredIntent } from '@agentic-obs/common';
import type { TopologyStore } from '@agentic-obs/data-layer';
import type { ChangeEventStore } from '@agentic-obs/adapters';
import type { Agent, AgentContext, AgentResult } from '../index.js';
import type { SystemContext, SloStatusProvider, IncidentProvider } from './types.js';

export interface ContextAgentDeps {
    topologyStore: TopologyStore;
    changeEventStore: ChangeEventStore;
    /** Optional: provide live SLO status. Omit to get 'unknown' status entries. */
    sloProvider?: SloStatusProvider;
    /** Optional: provide historical incidents. Omit to get an empty list. */
    incidentProvider?: IncidentProvider;
    /** How far back to look for recent changes, in ms (default: 24 hours) */
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
    /**
     * Resolve entity name to canonical node ID using fuzzy matching.
     * Order: exact name → exact ID → startsWith → includes → original string.
     */
    private resolveEntityId;
    private collectTopology;
    private collectChanges;
    private collectSloStatus;
    private collectIncidents;
    private deriveWindow;
}
//# sourceMappingURL=context-agent.d.ts.map