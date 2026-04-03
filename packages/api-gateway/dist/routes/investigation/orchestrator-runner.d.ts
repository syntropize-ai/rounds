import type { IGatewayInvestigationStore, IGatewayFeedStore } from '../../repositories/types.js';
export interface OrchestratorRunInput {
    investigationId: string;
    question: string;
    sessionId: string;
    userId: string;
}
export interface OrchestratorRunner {
    /** Fire-and-forget: starts async orchestration, does not block the caller. */
    run(input: OrchestratorRunInput): void;
}
export declare class StubOrchestratorRunner implements OrchestratorRunner {
    private readonly store;
    private readonly feed;
    constructor(store: IGatewayInvestigationStore, feed: IGatewayFeedStore);
    run(input: OrchestratorRunInput): void;
    private execute;
}
//# sourceMappingURL=orchestrator-runner.d.ts.map