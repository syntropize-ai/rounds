import type { SavedInvestigationReport } from '@agentic-obs/common';
import type {
  InvestigationCheck,
  InvestigationCompletionClaim,
  InvestigationRootCause,
  InvestigationWorkingState,
} from './investigation-state.js';

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

const MIN_CONFIDENCE = 0.8;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'because', 'by', 'caused', 'causing',
  'for', 'from', 'has', 'have', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or',
  'over', 'the', 'this', 'to', 'too', 'under', 'with',
]);

const TIME_SCOPE_RX = /\b(last|past|since|during|between|window|range|baseline|current|now|then|before|after|scope|scoped|only|all|one|per|by|where|tenant|region|zone|host|node|instance|service|workload|target|component)\b|\b\d+\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b|\b\d{4}-\d{2}-\d{2}t/i;
const VALIDATION_RX = /\b(validate|validation|verify|verification|confirm|check|test|monitor|observe|measure|rollout status|dry[- ]run|backtest|compare)\b/i;

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
  if (claim.confidence < MIN_CONFIDENCE) {
    reasons.push(`root-cause confidence must be at least ${MIN_CONFIDENCE}`);
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
  if (new Set(referenced.map((check) => check.signalType)).size < 2) {
    reasons.push('referenced evidence must include at least two independent signal types');
  }
  if (!hasDirectSupport(referenced, claim.rootCause)) {
    reasons.push('at least one referenced supported check must directly support the root-cause object and cause');
  }
  if (claim.ruledOut.length === 0) {
    reasons.push('ruledOut must include plausible competing explanations');
  }
  if (!checks.some((check) => check.status === 'ruled_out')) {
    reasons.push('at least one competing explanation must be recorded as ruled_out');
  }
  if (!referenced.some((check) => TIME_SCOPE_RX.test(checkText(check)))) {
    reasons.push('referenced evidence must establish time window or affected scope');
  }
  if (!hasValidationMethod(claim)) {
    reasons.push('nextAction or rootCause.nextCheck must state how to validate the fix or next finding');
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
  if (!validationMethod || !VALIDATION_RX.test(validationMethod)) {
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

function hasValidationMethod(claim: InvestigationCompletionClaim): boolean {
  const text = [claim.validationMethod ?? '', claim.nextAction ?? '', claim.rootCause.nextCheck ?? ''].join(' ');
  return VALIDATION_RX.test(text);
}

function planMatchesRootCause(targetObject: string, rootCause: InvestigationRootCause | undefined): boolean {
  if (!rootCause) return false;
  const rootTokens = significantTokens([rootCause.object ?? '', rootCause.field ?? ''].join(' '));
  if (rootTokens.length === 0) return false;
  const targetTokens = new Set(significantTokens(targetObject));
  return rootTokens.some((token) => targetTokens.has(token));
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
  return Array.from(new Set(tokens));
}
