// LLM-based action classification (replaces hardcoded keyword rules)

import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { ActionRule } from './types.js';
import type { Action, Hypothesis, Evidence } from '@agentic-obs/common';
import { stripCodeFences } from '../utils/llm-parse.js';

let _seq = 0;
function nextId(): string {
  return `act-${(++_seq).toString(36)}`;
}

// ---------------------------------------------------------------------------
// LLM response shape
// ---------------------------------------------------------------------------

interface LLMActionRecommendation {
  type?: unknown;
  description?: unknown;
  policyTag?: unknown;
  risk?: unknown;
  params?: unknown;
  rationale?: unknown;
}

interface LLMClassificationResponse {
  actions?: unknown[];
}

const VALID_TYPES = new Set<Action['type']>([
  'rollback', 'scale', 'restart', 'ticket', 'notify', 'runbook', 'feature_flag',
]);
const VALID_POLICY_TAGS = new Set<Action['policyTag']>(['suggest', 'approve_required', 'deny']);
const VALID_RISKS = new Set<Action['risk']>(['low', 'medium', 'high']);

// ---------------------------------------------------------------------------
// Core LLM classification function
// ---------------------------------------------------------------------------

export async function classifyAndRecommendActions(
  hypotheses: { hypothesis: Hypothesis; evidence: Evidence[] }[],
  entity: string,
  gateway: LLMGateway,
  model: string,
): Promise<Action[]> {
  const activeHypotheses = hypotheses.filter(
    (h) => h.hypothesis.status !== 'refuted',
  );

  if (activeHypotheses.length === 0) return [];

  const prompt = buildClassificationPrompt(activeHypotheses, entity);

  let raw: string;
  try {
    const response = await gateway.complete(
      [
        {
          role: 'system',
          content:
            'You are an expert SRE remediation advisor. Given investigation hypotheses and supporting evidence, recommend specific remediation actions. Always respond with valid JSON matching the required schema.',
        },
        { role: 'user', content: prompt },
      ],
      {
        model,
        temperature: 0.1,
        maxTokens: 2048,
        responseFormat: 'json',
      },
    );
    raw = response.content;
  } catch {
    // LLM unavailable — return empty actions so callers degrade gracefully
    return [];
  }

  return parseClassificationResponse(raw, activeHypotheses, entity);
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildClassificationPrompt(
  hypotheses: { hypothesis: Hypothesis; evidence: Evidence[] }[],
  entity: string,
): string {
  return JSON.stringify({
    instruction:
      'Analyze these investigation hypotheses and recommend specific remediation actions for the affected entity. ' +
      'For each action specify: type, description, policyTag, risk, params, and rationale. ' +
      'Only recommend actions that are clearly supported by the evidence. Do not recommend more than 5 actions.',
    entity,
    hypotheses: hypotheses.map((h) => ({
      id: h.hypothesis.id,
      investigationId: h.hypothesis.investigationId,
      description: h.hypothesis.description,
      confidence: h.hypothesis.confidence,
      status: h.hypothesis.status,
      evidenceCount: h.evidence.length,
    })),
    responseSchema: {
      actions: [
        {
          type: 'one of: rollback, scale, restart, ticket, notify, runbook, feature_flag',
          description: 'human-readable description of the action',
          policyTag: 'one of: suggest, approve_required, deny',
          risk: 'one of: low, medium, high',
          params:
            'object with relevant parameters (e.g. service, scaleDirection, severity)',
          rationale:
            'explanation of why this action addresses the root cause',
          hypothesisId: 'the id of the hypothesis this action addresses',
        },
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

function parseClassificationResponse(
  raw: string,
  hypotheses: { hypothesis: Hypothesis; evidence: Evidence[] }[],
  entity: string,
): Action[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(raw));
  } catch {
    return [];
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return [];
  }

  const obj = parsed as LLMClassificationResponse;
  const rawActions = Array.isArray(obj.actions) ? obj.actions : [];

  // Use the first hypothesis's investigationId as default
  const defaultInvestigationId =
    hypotheses[0]?.hypothesis.investigationId ?? '';

  const seen = new Set<string>();
  const actions: Action[] = [];

  for (const item of rawActions) {
    if (actions.length >= 5) break;
    if (typeof item !== 'object' || item === null) continue;

    const rec = item as LLMActionRecommendation;

    const type = String(rec.type ?? 'ticket');
    if (!VALID_TYPES.has(type as Action['type'])) continue;
    if (seen.has(type)) continue;
    seen.add(type);

    const policyTag = VALID_POLICY_TAGS.has(rec.policyTag as Action['policyTag'])
      ? (rec.policyTag as Action['policyTag'])
      : 'suggest';

    const risk = VALID_RISKS.has(rec.risk as Action['risk'])
      ? (rec.risk as Action['risk'])
      : 'low';

    const params =
      typeof rec.params === 'object' && rec.params !== null
        ? (rec.params as Record<string, unknown>)
        : { service: entity };

    actions.push({
      id: nextId(),
      investigationId: defaultInvestigationId,
      type: type as Action['type'],
      description: String(rec.description ?? `Recommended ${type} for ${entity}`),
      policyTag,
      status: 'proposed',
      params,
      risk,
    });
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Legacy ActionRule wrappers — kept so the old ExecutionAgent class still works
// ---------------------------------------------------------------------------

function makeLegacyRule(name: string): ActionRule {
  return {
    name,
    // Legacy matches() always returns false — classification is done by the
    // LLM via classifyAndRecommendActions(). These stubs exist only so code
    // that references the named exports still compiles.
    matches() {
      return false;
    },
    buildAction(hypothesis, _evidence, entity): Action {
      return {
        id: nextId(),
        investigationId: hypothesis.investigationId,
        type: 'ticket',
        description: `[legacy-stub] Open ticket for ${entity}: "${hypothesis.description}"`,
        policyTag: 'suggest',
        status: 'proposed',
        params: { service: entity, hypothesisId: hypothesis.id },
        risk: 'low',
      };
    },
    rationale(hypothesis) {
      return `Legacy stub rule for hypothesis "${hypothesis.description}". Use classifyAndRecommendActions() for LLM-based classification.`;
    },
  };
}

export const rollbackRule: ActionRule = makeLegacyRule('rollback-on-deploy');
export const scaleRule: ActionRule = makeLegacyRule('scale-on-saturation');
export const configReviewRule: ActionRule = makeLegacyRule('review-config-change');
export const genericTicketRule: ActionRule = makeLegacyRule('ticket-for-investigation');
export const criticalNotifyRule: ActionRule = makeLegacyRule('notify-on-critical');

export const DEFAULT_RULES: ActionRule[] = [
  rollbackRule,
  scaleRule,
  configReviewRule,
  genericTicketRule,
];
