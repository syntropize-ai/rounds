import { EventEmitter } from 'node:events';
import type { StructuredIntent } from '@agentic-obs/common';
import type { SystemContext } from '../context/types.js';
import type { InvestigationInput, InvestigationOutput } from '../investigation/types.js';
import type { EvidenceInput, EvidenceOutput } from '../evidence/types.js';
import type { IntentInput } from '../intent/types.js';
import type { AgentContext, AgentResult } from '../index.js';
import type { OrchestratorInput, OrchestratorOutput, OrchestratorEvent, OrchestratorConfig } from './types.js';

export interface IIntentAgent {
    parse(input: IntentInput): Promise<StructuredIntent>;
}

export interface IContextAgent {
    run(input: StructuredIntent, context: AgentContext): Promise<AgentResult<SystemContext>>;
}

export interface IInvestigationAgent {
    run(input: InvestigationInput, context: AgentContext): Promise<AgentResult<InvestigationOutput>>;
}

export interface IEvidenceAgent {
    run(input: EvidenceInput, context: AgentContext): Promise<AgentResult<EvidenceOutput>>;
}

export interface OrchestratorDeps {
    intentAgent: IIntentAgent;
    contextAgent: IContextAgent;
    investigationAgent: IInvestigationAgent;
    evidenceAgent: IEvidenceAgent;
    config?: Partial<OrchestratorConfig>;
}

export interface OrchestratorEmitter {
    on(event: 'orchestrator', listener: (e: OrchestratorEvent) => void): this;
    emit(event: 'orchestrator', data: OrchestratorEvent): boolean;
}

export declare class AgentOrchestrator extends EventEmitter implements OrchestratorEmitter {
    private readonly intentAgent;
    private readonly contextAgent;
    private readonly investigationAgent;
    private readonly evidenceAgent;
    private readonly config;
    constructor(deps: OrchestratorDeps);
    run(input: OrchestratorInput): Promise<OrchestratorOutput>;
    private pipeline;
    private buildExplanation;
    private buildOutput;
    private transitionTo;
    private transition;
    private emitStep;
    private emitDegraded;
    private emitEvent;
    private withTimeout;
}
//# sourceMappingURL=orchestrator.d.ts.map
