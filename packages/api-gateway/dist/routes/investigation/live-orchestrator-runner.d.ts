import type { IGatewayInvestigationStore, IGatewayFeedStore } from '../../repositories/types.js';
import type { OrchestratorRunner, OrchestratorRunInput } from './orchestrator-runner.js';
export declare class LiveOrchestratorRunner implements OrchestratorRunner {
    private readonly store;
    private readonly feed;
    constructor(store: IGatewayInvestigationStore, feed: IGatewayFeedStore);
    run(input: OrchestratorRunInput): void;
    private execute;
    private planInvestigation;
    private executeStep;
    private analyzeEvidence;
    private createGateway;
}
//# sourceMappingURL=live-orchestrator-runner.d.ts.map