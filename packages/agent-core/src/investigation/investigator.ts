import { randomUUID } from 'node:crypto';
import type { DataAdapter } from '@agentic-obs/adapters';
import type { LLMGateway } from '@agentic-obs/llm-gateway';
import { createLogger } from '@agentic-obs/common';
import type { InvestigationStep } from '@agentic-obs/common';

const log = createLogger('investigator');
import type { Agent, AgentContext, AgentResult } from '../index.js';
import type { CaseRetriever } from '../case-library/types.js';
import type {
  InvestigationConfig,
  InvestigationInput,
  InvestigationOutput,
  StopReason,
  StepType,
} from './types.js';
import { getStepsForTaskType, executeStep } from './steps.js';
import type { QueryBudget } from './steps.js';
import { generateHypotheses } from './hypotheses.js';
import { investigationOutputSchema } from './schema.js';

const DEFAULT_CONFIG: Required<InvestigationConfig> = {
  highConfidenceThreshold: 0.85,
  timeBudgetMs: 60_000,
  maxQueries: 50,
  skipSteps: [],
};

export interface InvestigationAgentDeps {
  adapter?: DataAdapter;
  config?: InvestigationConfig;
  /** Optional LLM gateway for hypothesis synthesis. When omitted, returns empty hypotheses. */
  llm?: LLMGateway;
  /** LLM model identifier. Required when llm is provided. */
  model?: string;
  /** Optional case retriever. When provided, similar past cases are injected into the LLM prompt. */
  caseRetriever?: CaseRetriever;
  /** Toggle case library injection. Defaults to true. Set to false to skip case retrieval entirely. */
  useCaseLibrary?: boolean;
}

export class InvestigationAgent implements Agent<InvestigationInput, InvestigationOutput> {
  readonly name = 'investigation';
  private readonly adapter?: DataAdapter;
  private readonly config: Required<InvestigationConfig>;
  private readonly llm?: LLMGateway;
  private readonly model?: string;
  private readonly caseRetriever?: CaseRetriever;
  private readonly useCaseLibrary: boolean;

  constructor(deps: InvestigationAgentDeps = {}) {
    this.adapter = deps.adapter;
    this.config = { ...DEFAULT_CONFIG, ...(deps.config ?? {}) };
    this.llm = deps.llm;
    this.model = deps.model;
    this.caseRetriever = deps.caseRetriever;
    this.useCaseLibrary = deps.useCaseLibrary ?? true;
  }

  async run(
    input: InvestigationInput,
    agentCtx: AgentContext,
  ): Promise<AgentResult<InvestigationOutput>> {
    try {
      const output = await this.investigate(input, agentCtx.investigationId);
      const validation = investigationOutputSchema.safeParse(output);
      if (!validation.success) {
        log.warn({ validationError: validation.error.format() }, 'output schema validation failed');
      }
      return { success: true, data: output };
    } catch (err) {
      return {
        success: false,
        error: `InvestigationAgent failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async investigate(
    input: InvestigationInput,
    investigationId: string,
  ): Promise<InvestigationOutput> {
    const startMs = Date.now();
    const { intent, context } = input;

    const stepTypes = getStepsForTaskType(intent.taskType).filter(
      (s) => !this.config.skipSteps.includes(s),
    );

    const planSteps: InvestigationStep[] = stepTypes.map((type) => ({
      id: randomUUID(),
      type,
      description: stepTypeDescription(type),
      status: 'pending' as const,
    }));

    const findings = [];
    let stopReason: StopReason = 'all_steps_complete';
    const queryBudget: QueryBudget = { count: 0, max: this.config.maxQueries };

    const stepCtxBase = {
      intent,
      context,
      adapter: this.adapter,
      queryBudget,
    };

    for (let i = 0; i < planSteps.length; i++) {
      const step = planSteps[i]!;
      const stepType = stepTypes[i]!;

      if (Date.now() - startMs >= this.config.timeBudgetMs) {
        step.status = 'skipped';
        stopReason = 'time_budget';
        for (let j = i + 1; j < planSteps.length; j++) {
          planSteps[j]!.status = 'skipped';
        }
        break;
      }

      if (queryBudget.count >= this.config.maxQueries) {
        step.status = 'skipped';
        stopReason = 'max_cost';
        for (let j = i + 1; j < planSteps.length; j++) {
          planSteps[j]!.status = 'skipped';
        }
        break;
      }

      step.status = 'running';
      const stepStartMs = Date.now();

      try {
        const finding = await executeStep(stepType, stepCtxBase);
        step.status = 'completed';
        step.result = finding;
        step.cost = { tokens: 0, queries: 0, latencyMs: Date.now() - stepStartMs };
        findings.push(finding);

        const partialHypotheses =
          this.llm !== undefined
            ? await generateHypotheses(investigationId, findings, this.llm, [], this.model)
            : [];

        if (
          partialHypotheses.length > 0 &&
          partialHypotheses[0]!.confidence >= this.config.highConfidenceThreshold
        ) {
          stopReason = 'high_confidence_hypothesis';
          for (let j = i + 1; j < planSteps.length; j++) {
            planSteps[j]!.status = 'skipped';
          }
          break;
        }
      } catch (err) {
        step.status = 'failed';
        step.result = { error: err instanceof Error ? err.message : String(err) };
        step.cost = { tokens: 0, queries: 0, latencyMs: Date.now() - stepStartMs };
      }
    }

    const historicalCases =
      this.useCaseLibrary && this.caseRetriever && findings.length > 0
        ? this.caseRetriever.search({
            symptoms: findings.filter((f) => f.isAnomaly).map((f) => f.summary),
            services: [intent.entity],
            topK: 3,
          })
        : [];

    const hypotheses = await generateHypotheses(
      investigationId,
      findings,
      this.llm,
      historicalCases,
      this.model,
    );

    return {
      plan: {
        entity: intent.entity,
        objective: intent.goal,
        steps: planSteps,
        stopConditions: [
          {
            type: 'high_confidence_hypothesis',
            params: { threshold: this.config.highConfidenceThreshold },
          },
          { type: 'max_queries', params: { maxQueries: this.config.maxQueries } },
          { type: 'time_budget', params: { timeBudgetMs: this.config.timeBudgetMs } },
        ],
      },
      hypotheses,
      findings,
      stopReason,
    };
  }
}

function stepTypeDescription(type: StepType): string {
  const descriptions: Record<StepType, string> = {
    compare_latency_vs_baseline:
      'Compare current p95 latency against the established SLO baseline',
    check_error_rate: 'Measure current error rate and compare against SLO threshold',
    inspect_downstream: 'Check health and SLO status of downstream service dependencies',
    correlate_deployments: 'Identify deployments or config changes within the investigation window',
    sample_traces: 'Sample representative distributed traces for latency breakdown',
    cluster_logs: 'Cluster log lines to surface repeated error patterns',
    check_saturation: 'Check CPU, memory, and other resource saturation levels',
    check_traffic_pattern: 'Analyze request rate for traffic spikes or drops',
    check_slo_burn_rate: 'Calculate SLO error budget burn rate across all indicators',
    check_error_distribution:
      'Determine if errors originate locally or propagate from dependencies',
  };
  return descriptions[type];
}
