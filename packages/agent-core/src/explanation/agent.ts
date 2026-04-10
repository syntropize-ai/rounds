// ExplanationAgent - generates structured SRE conclusions from hypotheses + evidence

import type { LLMGateway } from '@agentic-obs/llm-gateway';
import { createLogger } from '@agentic-obs/common';
import type { Hypothesis, Action } from '@agentic-obs/common';

const log = createLogger('explanation-agent');
import type { Agent, AgentContext, AgentResult } from '../index.js';
import type {
  ExplanationInput,
  StructuredConclusion,
  RankedHypothesis,
  ImpactAssessment,
  RecommendedAction,
} from './types.js';
import { ExplanationParseError } from './types.js';
import { getSystemPrompt, buildExplanationUserMessage } from './prompts.js';
import { structuredConclusionSchema } from './schema.js';
import { stripCodeFences } from '../utils/llm-parse.js';

export interface ExplanationAgentOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
}

const DEFAULT_OPTIONS: Omit<Required<ExplanationAgentOptions>, 'model'> = {
  temperature: 0.1,
  maxTokens: 2048,
};

// -- Internal LLM response shape -----------------------------------------

interface LLMHypothesisEntry {
  hypothesisId: string;
  rank: number;
  evidenceSummary?: string;
  confidenceExplanation?: string;
}

interface LLMAction {
  type?: Action['type'];
  description?: string;
  policyTag?: Action['policyTag'];
  params?: Record<string, unknown>;
  risk?: Action['risk'];
  rationale?: string;
  expectedOutcome?: string;
  riskDescription?: string;
}

interface LLMConclusion {
  summary: string;
  hypotheses: LLMHypothesisEntry[];
  impact: {
    severity?: ImpactAssessment['severity'];
    affectedServices?: string[];
    affectedUsers?: string;
    description?: string;
  };
  recommendedActions: LLMAction[];
  risks: string[];
  uncoveredAreas: string[];
}

// -- Agent ----------------------------------------------------------------

export class ExplanationAgent implements Agent<ExplanationInput, StructuredConclusion> {
  readonly name = 'explanation';

  private readonly gateway: LLMGateway;
  private readonly options: Required<ExplanationAgentOptions>;

  constructor(gateway: LLMGateway, options: ExplanationAgentOptions) {
    this.gateway = gateway;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Generate a StructuredConclusion from hypotheses and their evidence chains.
   * Does not modify any evidence content - only rephrases and ranks.
   */
  async explain(input: ExplanationInput): Promise<StructuredConclusion> {
    const response = await this.gateway.complete([
      { role: 'system', content: getSystemPrompt(input.audience ?? 'sre') },
      { role: 'user', content: buildExplanationUserMessage(input) },
    ], {
      model: this.options.model,
      temperature: this.options.temperature,
      maxTokens: this.options.maxTokens,
      responseFormat: 'json',
    });

    return this.parseResponse(response.content, input);
  }

  /**
   * Like explain(), but returns null on LLM/parse errors rather than throwing.
   * Callers should surface "AI unavailable - please retry" to the user.
   */
  async safeExplain(input: ExplanationInput): Promise<StructuredConclusion | null> {
    try {
      return await this.explain(input);
    } catch {
      return null;
    }
  }

  /** Agent interface - wraps explain() with AgentResult envelope. */
  async run(
    input: ExplanationInput,
    _context: AgentContext,
  ): Promise<AgentResult<StructuredConclusion>> {
    try {
      const data = await this.explain(input);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // -- Parsing ------------------------------------------------------------

  private parseResponse(raw: string, input: ExplanationInput): StructuredConclusion {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFences(raw));
    } catch {
      throw new ExplanationParseError(
        `LLM returned non-JSON content: ${raw.slice(0, 200)}`,
        raw,
      );
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ExplanationParseError('LLM response must be a JSON object', raw);
    }

    const obj = parsed as Record<string, unknown>;
    if (typeof obj['summary'] !== 'string') {
      throw new ExplanationParseError('Missing or invalid "summary" field', raw);
    }
    if (!Array.isArray(obj['hypotheses'])) {
      throw new ExplanationParseError('Missing or invalid "hypotheses" array', raw);
    }

    const llmConclusion = obj as unknown as LLMConclusion;

    // Build hypothesis index for lookup
    const hypothesisById = new Map<string, Hypothesis>(
      input.hypotheses.map((h) => [h.id, h]),
    );

    // Map ranked hypotheses - only include entries that match input hypothesis IDs
    const rankedHypotheses: RankedHypothesis[] = llmConclusion.hypotheses
      .filter((e) => hypothesisById.has(e.hypothesisId))
      .map((e) => ({
        hypothesis: hypothesisById.get(e.hypothesisId)!,
        rank: e.rank,
        evidenceSummary: e.evidenceSummary ?? '',
        confidenceExplanation: e.confidenceExplanation ?? '',
      }))
      .sort((a, b) => a.rank - b.rank);

    // Add any hypotheses the LLM omitted (at the end, unranked)
    const rankedIds = new Set(rankedHypotheses.map((r) => r.hypothesis.id));
    let nextRank = rankedHypotheses.length + 1;
    for (const h of input.hypotheses) {
      if (!rankedIds.has(h.id)) {
        rankedHypotheses.push({
          hypothesis: h,
          rank: nextRank++,
          evidenceSummary: 'No summary provided by LLM.',
          confidenceExplanation: `Confidence: ${h.confidence}`,
        });
      }
    }

    const impact: ImpactAssessment = {
      severity: llmConclusion.impact?.severity ?? 'medium',
      affectedServices: llmConclusion.impact?.affectedServices ?? [input.context.entity],
      affectedUsers: llmConclusion.impact?.affectedUsers ?? 'Unknown',
      description: llmConclusion.impact?.description ?? '',
    };

    let actionSeq = 0;
    const recommendedActions: RecommendedAction[] = (llmConclusion.recommendedActions ?? []).map((a) => {
      const action: Action = {
        id: `act-${++actionSeq}`,
        investigationId: '',
        type: a.type ?? 'ticket',
        description: a.description ?? '',
        policyTag: a.policyTag ?? 'suggest',
        status: 'proposed',
        params: a.params ?? {},
        risk: a.risk ?? 'low',
      };
      return {
        action,
        rationale: a.rationale ?? '',
        expectedOutcome: a.expectedOutcome ?? '',
        risk: a.riskDescription ?? '',
      };
    });

    const conclusion: StructuredConclusion = {
      summary: llmConclusion.summary,
      hypotheses: rankedHypotheses,
      impact,
      recommendedActions,
      risks: llmConclusion.risks ?? [],
      uncoveredAreas: llmConclusion.uncoveredAreas ?? [],
      generatedAt: new Date().toISOString(),
    };

    const validation = structuredConclusionSchema.safeParse(conclusion);
    if (!validation.success) {
      log.warn({ validationError: validation.error.format() }, 'StructuredConclusion schema validation failed');
    }

    return conclusion;
  }
}
