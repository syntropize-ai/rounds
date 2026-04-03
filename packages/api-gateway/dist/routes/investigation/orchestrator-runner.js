// Orchestrator runner - decouples the HTTP router from agent pipeline details.
// Inject OrchestratorRunner into createInvestigationRouter for testability.
// Stub implementation (no live agents)
// Transitions the investigation through all states and writes a fixed item.
// Replace with a real AgentOrchestrator-backed runner in production.
export class StubOrchestratorRunner {
    store;
    feed;
    constructor(store, feed) {
        this.store = store;
        this.feed = feed;
    }
    run(input) {
        void this.execute(input);
    }
    async execute(input) {
        const { investigationId, question } = input;
        try {
            await this.store.updateStatus(investigationId, 'investigating');
            await Promise.resolve();
            await this.store.updateStatus(investigationId, 'evidencing');
            await Promise.resolve();
            await this.store.updateStatus(investigationId, 'explaining');
            await Promise.resolve();
            const conclusion = {
                rootCause: null,
                confidence: 0,
                recommendedActions: ['Configure IntentAgent, ContextAgent, InvestigationAgent, and EvidenceAgent'],
                summary: 'No live agents configured - stub investigation completed.',
            };
            await this.store.updateResult(investigationId, { hypotheses: [], evidence: [], conclusion });
            await this.store.updateStatus(investigationId, 'completed');
            await this.feed.add('investigation_complete', question.length > 60 ? `${question.slice(0, 57)}...` : question, conclusion.summary, 'low', investigationId);
        }
        catch {
            await this.store.updateStatus(investigationId, 'failed');
        }
    }
}
//# sourceMappingURL=orchestrator-runner.js.map