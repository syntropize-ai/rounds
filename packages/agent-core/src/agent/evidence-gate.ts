import type { SavedInvestigationReport } from '@agentic-obs/common';
import { explainGateReasons, MIN_ROOT_CAUSE_CONFIDENCE } from '@agentic-obs/common';

// Re-exported so agent-core callers keep one import site for gate concerns.
export { explainGateReasons };
import type {
  InvestigationCheck,
  InvestigationCompletionClaim,
  InvestigationRootCause,
  InvestigationWorkingState,
  ReadFamily,
} from './investigation-state.js';
import { readFamilyForTool } from './investigation-state.js';

export interface RootCauseEvidenceGateResult {
  status: 'passed' | 'unresolved';
  reasons: string[];
  rootCause?: InvestigationRootCause;
  confidence: number;
  evidenceRefs: string[];
  ruledOut: string[];
  validationMethod?: string;
  evaluatedAt: string;
}

export interface RemediationPlanEvidenceGateResult {
  status: 'passed' | 'rejected';
  reasons: string[];
  investigationGate?: RootCauseEvidenceGateResult;
}

type ProvenanceWithRootCauseGate = NonNullable<SavedInvestigationReport['provenance']> & {
  rootCauseGate?: RootCauseEvidenceGateResult;
};

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'because', 'by', 'caused', 'causing',
  'for', 'from', 'has', 'have', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or',
  'over', 'the', 'this', 'to', 'too', 'under', 'with',
]);

// Han / Hiragana / Katakana / Hangul runs carry no word separators, so the
// latin tokenizer below drops them wholesale. Score them as character bigrams
// instead — otherwise every non-English investigation has zero root-cause
// tokens and can never establish direct support.
const CJK_RUN_RX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+/g;

export function evaluateInvestigationEvidenceGate(
  state: InvestigationWorkingState | undefined,
  claim: InvestigationCompletionClaim,
  nowIso = new Date().toISOString(),
): RootCauseEvidenceGateResult {
  if (claim.rootCause.status === 'unresolved') {
    const reasons: string[] = [];
    if (!claim.rootCause.nextCheck && !claim.nextAction) {
      reasons.push('unresolved investigation must name the next check or unavailable data');
    }
    return {
      status: 'unresolved',
      reasons,
      rootCause: claim.rootCause,
      confidence: claim.confidence,
      evidenceRefs: claim.evidenceRefs,
      ruledOut: claim.ruledOut,
      validationMethod: claim.validationMethod,
      evaluatedAt: nowIso,
    };
  }

  const checks = state?.checks ?? [];
  const byId = new Map(checks.map((check) => [check.id, check]));
  const referenced = claim.evidenceRefs
    .map((id) => byId.get(id))
    .filter((check): check is InvestigationCheck => Boolean(check));

  const reasons: string[] = [];
  if (claim.confidence < MIN_ROOT_CAUSE_CONFIDENCE) {
    reasons.push(`root-cause confidence must be at least ${MIN_ROOT_CAUSE_CONFIDENCE}`);
  }
  if (!claim.rootCause.object) {
    reasons.push('rootCause.object must name the specific repair target');
  }
  if (!claim.rootCause.cause) {
    reasons.push('rootCause.cause must describe the causal mechanism');
  }
  if (claim.evidenceRefs.length === 0) {
    reasons.push('evidenceRefs must point to recorded investigation checks');
  }
  if (referenced.length !== claim.evidenceRefs.length) {
    reasons.push('all evidenceRefs must match recorded check ids');
  }
  if (referenced.length < 2) {
    reasons.push('at least two recorded checks must be referenced');
  }
  // Independence is counted in read families, not in the signal-type label the
  // model wrote. Two things went wrong when it was counted by label: checks
  // citing no real tool at all counted as evidence, and two calls to the same
  // metrics tool counted as two independent signals if they were tagged
  // differently. A family is a distinct place the answer could have come from.
  const backed = referenced
    .map((check) => ({ check, family: readFamilyForTool(check.tool, check.signalType) }))
    .filter((entry): entry is { check: InvestigationCheck; family: ReadFamily } => entry.family !== null);
  if (new Set(backed.map((entry) => entry.family)).size < 2) {
    reasons.push(
      'referenced evidence must include at least two independent signal types from metrics, logs, Kubernetes state or change events',
    );
  }
  if (!hasDirectSupport(backed.map((entry) => entry.check), claim.rootCause)) {
    reasons.push('at least one referenced supported check must directly support the root-cause object and cause');
  }
  if (claim.ruledOut.length === 0) {
    reasons.push('ruledOut must include plausible competing explanations');
  }
  if (!checks.some((check) => check.status === 'ruled_out')) {
    reasons.push('at least one competing explanation must be recorded as ruled_out');
  }
  if (!referenced.some(hasRecordedScope)) {
    reasons.push('at least one referenced check must record scope.timeWindow or scope.affected');
  }
  if (!claim.validationMethod?.trim()) {
    reasons.push('validationMethod must state how to validate the fix or next finding');
  }

  return {
    status: reasons.length === 0 ? 'passed' : 'unresolved',
    reasons,
    rootCause: claim.rootCause,
    confidence: claim.confidence,
    evidenceRefs: claim.evidenceRefs,
    ruledOut: claim.ruledOut,
    validationMethod: claim.validationMethod,
    evaluatedAt: nowIso,
  };
}

export function validateRemediationPlanEvidence(
  reports: SavedInvestigationReport[],
  plan: { targetObject: string; validationMethod: string },
): RemediationPlanEvidenceGateResult {
  const latest = [...reports].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const gate = (latest?.provenance as ProvenanceWithRootCauseGate | undefined)?.rootCauseGate;
  const reasons: string[] = [];
  const targetObject = plan.targetObject.trim();
  const validationMethod = plan.validationMethod.trim();

  if (!latest) {
    reasons.push('no saved investigation report was found');
  }
  if (!gate) {
    reasons.push('latest investigation report has no root-cause evidence gate result');
  } else if (gate.status !== 'passed') {
    reasons.push(`latest investigation root cause is not verified: ${gate.reasons.join('; ') || 'unresolved'}`);
  }
  if (!targetObject) {
    reasons.push('plan must name targetObject');
  }
  if (gate?.status === 'passed' && !planMatchesRootCause(targetObject, gate.rootCause)) {
    reasons.push('plan target does not match the verified root-cause object or field');
  }
  if (!validationMethod) {
    reasons.push('plan must include an explicit verification or validation method');
  }

  return {
    status: reasons.length === 0 ? 'passed' : 'rejected',
    reasons,
    ...(gate ? { investigationGate: gate } : {}),
  };
}

function hasDirectSupport(checks: InvestigationCheck[], rootCause: InvestigationRootCause): boolean {
  const rootTokens = significantTokens([
    rootCause.object ?? '',
    rootCause.field ?? '',
    rootCause.cause ?? '',
  ].join(' '));
  if (rootTokens.length === 0) return false;

  return checks.some((check) => {
    if (check.status !== 'supported') return false;
    const textTokens = new Set(significantTokens(checkText(check)));
    const overlap = rootTokens.filter((token) => textTokens.has(token));
    return overlap.length >= Math.min(2, rootTokens.length);
  });
}

function hasRecordedScope(check: InvestigationCheck): boolean {
  return Boolean(check.scope.timeWindow?.trim() || check.scope.affected?.trim());
}

function planMatchesRootCause(targetObject: string, rootCause: InvestigationRootCause | undefined): boolean {
  if (!rootCause) return false;
  const rootTokens = significantTokens([rootCause.object ?? '', rootCause.field ?? ''].join(' '));
  if (rootTokens.length === 0) return false;
  const targetTokens = new Set(significantTokens(targetObject));
  // Same two-token bar as hasDirectSupport. A single shared token is too weak:
  // it lets a plan against deploy/api clear a root cause proven on deploy/web.
  const overlap = rootTokens.filter((token) => targetTokens.has(token));
  return overlap.length >= Math.min(2, rootTokens.length);
}

function checkText(check: InvestigationCheck): string {
  return [
    check.hypothesis,
    check.signalType,
    check.tool,
    check.query,
    check.result,
    check.interpretation,
    check.nextCheck ?? '',
  ].join(' ');
}

function significantTokens(value: string): string[] {
  const tokens = value
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, ' ')
    .split(/\s+/)
    .flatMap((token) => token.split(/[_.:/-]+/))
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
  return Array.from(new Set([...tokens, ...cjkTokens(value)]));
}

function cjkTokens(value: string): string[] {
  const tokens: string[] = [];
  for (const run of value.match(CJK_RUN_RX) ?? []) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i += 1) {
      tokens.push(run.slice(i, i + 2));
    }
  }
  return tokens;
}


