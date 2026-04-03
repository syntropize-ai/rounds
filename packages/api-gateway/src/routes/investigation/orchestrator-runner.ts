// Orchestrator runner - decouples the HTTP router from agent pipeline details.
// Inject OrchestratorRunner into createInvestigationRouter for testability.

import { createLogger } from '@agentic-obs/common';
import type { ExplanationResult } from '@agentic-obs/agent-core';
import type { IGatewayInvestigationStore, IGatewayFeedStore } from '../../repositories/types.js';

const log = createLogger('orchestrator-runner');

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

// Stub implementation (no live agents)
// Transitions the investigation through all states and writes a fixed item.
// Replace with a real AgentOrchestrator-backed runner in production.
export class StubOrchestratorRunner implements OrchestratorRunner {
  constructor(
    private readonly store: IGatewayInvestigationStore,
    private readonly feed: IGatewayFeedStore,
  ) {}

  run(input: OrchestratorRunInput): void {
    void this.execute(input).catch((err) => {
      log.error({ err }, 'async execution failed');
    });
  }

  private async execute(input: OrchestratorRunInput): Promise<void> {
    const { investigationId, question } = input;
    try {
      await this.store.updateStatus(investigationId, 'investigating');
      await Promise.resolve();

      await this.store.updateStatus(investigationId, 'evidencing');
      await Promise.resolve();

      await this.store.updateStatus(investigationId, 'explaining');
      await Promise.resolve();

      const conclusion: ExplanationResult = {
        rootCause: null,
        confidence: 0,
        recommendedActions: ['Configure IntentAgent, ContextAgent, InvestigationAgent, and EvidenceAgent'],
        summary: 'No live agents configured - stub investigation completed.',
      };

      await this.store.updateResult(investigationId, { hypotheses: [], evidence: [], conclusion });
      await this.store.updateStatus(investigationId, 'completed');

      await this.feed.add(
        'investigation_complete',
        question.length > 60 ? `${question.slice(0, 57)}...` : question,
        conclusion.summary,
        'low',
        investigationId,
      );
    } catch {
      await this.store.updateStatus(investigationId, 'failed');
    }
  }
}
