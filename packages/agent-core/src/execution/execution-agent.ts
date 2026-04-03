import { randomUUID } from 'node:crypto';
import { createLogger, DEFAULT_LLM_MODEL, LLMUnavailableError } from '@agentic-obs/common';

const log = createLogger('execution-agent');
import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { ActionGuard, CredentialResolver } from '@agentic-obs/guardrails';
import type { AdapterRegistry } from './adapter-registry.js';
import type { AdapterAction, ExecutionResult } from './types.js';
import type {
  ExecutionContext,
  ExecutionPlan,
  PlannedAction,
  GuardedPlan,
  ResultEvaluation,
  InvestigationConclusion,
} from './execution-agent-types.js';

export interface ExecutionAgentConfig {
  llm: LLMGateway;
  adapterRegistry: AdapterRegistry;
  actionGuard: ActionGuard;
  credentialResolver?: CredentialResolver;
  model?: string;
  temperature?: number;
}

interface AuditEntry {
  timestamp: string;
  investigationId: string;
  actionType: string;
  targetService: string;
  credentialRef?: string;
  result: 'success' | 'failed';
  executionId: string;
  error?: string;
}

interface LLMPlannedAction {
  action?: unknown;
  riskLevel?: unknown;
  reasoning?: unknown;
  priority?: unknown;
}

interface LLMPlanResponse {
  actions?: unknown;
  reasoning?: unknown;
}

interface LLMEvaluationResponse {
  outcome?: unknown;
  nextSteps?: unknown;
  shouldRollback?: unknown;
  reasoning?: unknown;
}

export class LLMExecutionAgent {
  private readonly llm: LLMGateway;
  private readonly adapterRegistry: AdapterRegistry;
  private readonly actionGuard: ActionGuard;
  private readonly credentialResolver?: CredentialResolver;
  private readonly model: string;
  private readonly temperature: number;
  private readonly auditTrail: AuditEntry[] = [];
  private readonly AUDIT_MAX_SIZE = 10_000;

  constructor(config: ExecutionAgentConfig) {
    this.llm = config.llm;
    this.adapterRegistry = config.adapterRegistry;
    this.actionGuard = config.actionGuard;
    this.credentialResolver = config.credentialResolver;
    this.model = config.model ?? DEFAULT_LLM_MODEL;
    this.temperature = config.temperature ?? 0.1;
  }

  async plan(conclusion: InvestigationConclusion, context: ExecutionContext): Promise<ExecutionPlan> {
    let raw: string;
    try {
      const response = await this.llm.complete([
        {
          role: 'system',
          content: 'You are an expert SRE execution planner. Given an investigation conclusion, recommend specific, targeted remediation actions. Always respond with valid JSON matching the required schema.',
        },
        { role: 'user', content: this.buildPlanPrompt(conclusion, context) },
      ], {
        model: this.model,
        temperature: this.temperature,
        maxTokens: 2048,
        responseFormat: 'json',
      });
      raw = response.content;
    } catch {
      return { actions: [], reasoning: 'LLM unavailable - no actions planned' };
    }
    return this.parsePlanResponse(raw);
  }

  async guard(plan: ExecutionPlan): Promise<GuardedPlan> {
    const approved: PlannedAction[] = [];
    const needsApproval: PlannedAction[] = [];
    const denied: PlannedAction[] = [];

    for (const plannedAction of plan.actions) {
      const actionInput = {
        type: plannedAction.action.type,
        targetService: plannedAction.action.targetService,
        params: plannedAction.action.params,
      };
      const decision = this.actionGuard.evaluate(actionInput);
      if (decision.effect === 'allow') approved.push(plannedAction);
      else if (decision.effect === 'require_approval') needsApproval.push(plannedAction);
      else denied.push(plannedAction);
    }

    return { approved, needsApproval, denied };
  }

  async execute(action: PlannedAction, context?: ExecutionContext): Promise<ExecutionResult> {
    const adapters = this.adapterRegistry.getByCapability(action.action.type);
    const executionId = randomUUID();

    if (adapters.length === 0) {
      const result: ExecutionResult = {
        success: false,
        output: null,
        rollbackable: false,
        executionId,
        error: `No adapter found for action type: ${action.action.type}`,
      };
      this.recordAudit(action, result, context?.investigationId);
      return result;
    }

    const adapter = adapters[0]!;
    let boundAction: AdapterAction = action.action;

    if (action.action.credentialRef) {
      const ref = action.action.credentialRef;
      if (!this.credentialResolver) {
        const result: ExecutionResult = {
          success: false,
          output: null,
          rollbackable: false,
          executionId,
          error: `Action requires credential '${ref}' but no CredentialResolver is configured`,
        };
        this.recordAudit(action, result);
        return result;
      }

      let resolved: string | undefined;
      try {
        const cred = await this.credentialResolver.resolve(ref);
        resolved = cred?.value;
      } catch (err) {
        const result: ExecutionResult = {
          success: false,
          output: null,
          rollbackable: false,
          executionId,
          error: `Failed to resolve credential '${ref}': ${err instanceof Error ? err.message : String(err)}`,
        };
        this.recordAudit(action, result);
        return result;
      }

      if (resolved === undefined) {
        const result: ExecutionResult = {
          success: false,
          output: null,
          rollbackable: false,
          executionId,
          error: `Credential '${ref}' could not be resolved - action aborted`,
        };
        this.recordAudit(action, result);
        return result;
      }

      boundAction = { ...action.action, resolvedCredential: resolved };
    }

    let validation;
    try {
      validation = await adapter.validate(boundAction);
    } catch (err) {
      const result: ExecutionResult = {
        success: false,
        output: null,
        rollbackable: false,
        executionId,
        error: `Validation threw: ${err instanceof Error ? err.message : String(err)}`,
      };
      this.recordAudit(action, result, context?.investigationId);
      return result;
    }

    if (!validation.valid) {
      const result: ExecutionResult = {
        success: false,
        output: null,
        rollbackable: false,
        executionId,
        error: `Validation failed: ${validation.reason}`,
      };
      this.recordAudit(action, result, context?.investigationId);
      return result;
    }

    try {
      const dryRun = await adapter.dryRun(boundAction);
      if (dryRun.warnings.length > 0) {
        log.warn({ warnings: dryRun.warnings }, 'dryRun warnings');
      }
    } catch (err) {
      log.warn({ err }, 'dryRun failed (proceeding)');
    }

    let result: ExecutionResult;
    try {
      result = await adapter.execute(boundAction);
    } catch (err) {
      result = {
        success: false,
        output: null,
        rollbackable: false,
        executionId,
        error: `Execute threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (boundAction !== action.action) {
      boundAction.resolvedCredential = undefined;
    }

    this.recordAudit(action, result);
    return result;
  }

  async evaluateResult(result: ExecutionResult, context: ExecutionContext): Promise<ResultEvaluation> {
    let raw: string;
    try {
      const response = await this.llm.complete([
        {
          role: 'system',
          content: 'You are an SRE expert evaluating the outcome of a remediation action. Determine if it succeeded, suggest next steps, and whether rollback is needed. Always respond with valid JSON matching the required schema.',
        },
        { role: 'user', content: this.buildEvaluationPrompt(result, context) },
      ], {
        model: this.model,
        temperature: this.temperature,
        maxTokens: 1024,
        responseFormat: 'json',
      });
      raw = response.content;
    } catch {
      throw new LLMUnavailableError();
    }
    return this.parseEvaluationResponse(raw, result);
  }

  getAuditTrail(): AuditEntry[] {
    return [...this.auditTrail];
  }

  private buildPlanPrompt(conclusion: InvestigationConclusion, context: ExecutionContext): string {
    const topHypothesis = conclusion.hypotheses[0];
    return JSON.stringify({
      instruction: 'Based on this investigation conclusion, recommend specific remediation actions. For each action specify: type, target service, parameters, risk level, and reasoning.',
      investigationId: context.investigationId,
      symptoms: context.symptoms,
      affectedServices: context.services,
      conclusion: {
        summary: conclusion.summary,
        topHypothesis: topHypothesis
          ? {
              description: topHypothesis.hypothesis.description,
              confidence: topHypothesis.hypothesis.confidence,
              evidenceSummary: topHypothesis.evidenceSummary,
            }
          : null,
        impact: conclusion.impact,
        existingRecommendations: conclusion.recommendedActions.map((r) => ({
          type: r.action.type,
          description: r.action.description,
          rationale: r.rationale,
        })),
      },
      responseSchema: {
        actions: [{
          action: {
            type: 'string - adapter capability e.g. k8s:scale, k8s:restart, k8s:rollback, slack:notify',
            targetService: 'string',
            params: 'object with adapter-specific parameters',
            credentialRef: 'optional string',
          },
          riskLevel: 'low | medium | high | critical',
          reasoning: 'string explaining why this action addresses the root cause',
          priority: 'number - 1 is highest priority',
        }],
        reasoning: 'string - overall plan reasoning',
      },
    });
  }

  private buildEvaluationPrompt(result: ExecutionResult, context: ExecutionContext): string {
    return JSON.stringify({
      instruction: 'Evaluate the execution result of a remediation action. Determine the outcome, suggest concrete next steps, and whether rollback is needed.',
      investigationId: context.investigationId,
      symptoms: context.symptoms,
      affectedServices: context.services,
      executionResult: {
        success: result.success,
        output: result.output,
        rollbackable: result.rollbackable,
        error: result.error ?? null,
      },
      responseSchema: {
        outcome: 'success | partial | failed',
        nextSteps: ['array of concrete next-step strings'],
        shouldRollback: 'boolean',
        reasoning: 'string',
      },
    });
  }

  private parsePlanResponse(raw: string): ExecutionPlan {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFences(raw));
    } catch {
      return { actions: [], reasoning: 'LLM response could not be parsed' };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { actions: [], reasoning: 'LLM returned invalid response shape' };
    }
    const obj = parsed as LLMPlanResponse;
    const rawActions = Array.isArray(obj.actions) ? obj.actions : [];
    const actions: PlannedAction[] = rawActions
      .filter((a) => typeof a === 'object' && a !== null)
      .map((a) => {
        const x = a as LLMPlannedAction;
        const actionObj = typeof x.action === 'object' && x.action !== null ? x.action as Record<string, unknown> : {};
        const adapterAction: AdapterAction = {
          type: String(actionObj.type ?? 'unknown'),
          targetService: String(actionObj.targetService ?? ''),
          params: typeof actionObj.params === 'object' && actionObj.params !== null ? actionObj.params as Record<string, unknown> : {},
          credentialRef: actionObj.credentialRef != null ? String(actionObj.credentialRef) : undefined,
        };
        return {
          action: adapterAction,
          riskLevel: isRiskLevel(x.riskLevel) ? x.riskLevel : 'medium',
          reasoning: String(x.reasoning ?? ''),
          priority: typeof x.priority === 'number' ? x.priority : 99,
        };
      });
    return {
      actions,
      reasoning: String(obj.reasoning ?? ''),
    };
  }

  private parseEvaluationResponse(raw: string, result: ExecutionResult): ResultEvaluation {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFences(raw));
    } catch {
      throw new Error('LLM returned non-JSON content for evaluation');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('LLM returned invalid response shape for evaluation');
    }
    const obj = parsed as LLMEvaluationResponse;
    const outcomeRaw = obj.outcome;
    const outcome = outcomeRaw === 'success' || outcomeRaw === 'partial' || outcomeRaw === 'failed'
      ? outcomeRaw
      : 'pending_llm';
    return {
      outcome,
      nextSteps: Array.isArray(obj.nextSteps) ? obj.nextSteps.map(String) : [],
      shouldRollback: typeof obj.shouldRollback === 'boolean' ? obj.shouldRollback : false,
      reasoning: String(obj.reasoning ?? ''),
    };
  }

  private recordAudit(action: PlannedAction, result: ExecutionResult, investigationId = ''): void {
    this.auditTrail.push({
      timestamp: new Date().toISOString(),
      investigationId,
      actionType: action.action.type,
      targetService: action.action.targetService,
      credentialRef: action.action.credentialRef,
      result: result.success ? 'success' : 'failed',
      executionId: result.executionId,
      error: result.error,
    });
    if (this.auditTrail.length > this.AUDIT_MAX_SIZE) {
      this.auditTrail.shift();
    }
  }
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return match?.[1]?.trim() ?? trimmed;
}

function isRiskLevel(v: unknown): v is PlannedAction['riskLevel'] {
  return v === 'low' || v === 'medium' || v === 'high' || v === 'critical';
}
