export type InvestigationSignalType =
  | 'metric'
  | 'log'
  | 'kubernetes'
  | 'change'
  | 'trace'
  | 'config'
  | 'knowledge'
  | 'web'
  | 'other';

export type HypothesisStatus = 'supported' | 'ruled_out' | 'inconclusive';

export interface InvestigationCheck {
  id: string;
  hypothesis: string;
  signalType: InvestigationSignalType;
  tool: string;
  query: string;
  result: string;
  interpretation: string;
  status: HypothesisStatus;
  nextCheck?: string;
}

export interface InvestigationHypothesis {
  text: string;
  status: HypothesisStatus;
  evidenceCheckIds: string[];
}

export interface InvestigationRootCause {
  status: 'confirmed' | 'likely' | 'unresolved';
  object?: string;
  field?: string;
  cause?: string;
  nextCheck?: string;
}

export interface InvestigationCompletionClaim {
  rootCause: InvestigationRootCause;
  confidence: number;
  evidenceRefs: string[];
  ruledOut: string[];
  nextAction?: string;
}

export interface InvestigationWorkingState {
  checks: InvestigationCheck[];
  hypotheses: InvestigationHypothesis[];
  completionGateRounds: number;
}

export interface InvestigationReadinessInput {
  question: string;
  summary: string;
  sectionsText: string;
  claim: InvestigationCompletionClaim;
  state: InvestigationWorkingState;
  hasOpsConnector: boolean;
}

export interface InvestigationReadinessResult {
  ok: boolean;
  reason?: string;
}

export function createInvestigationWorkingState(): InvestigationWorkingState {
  return {
    checks: [],
    hypotheses: [],
    completionGateRounds: 0,
  };
}

export function normalizeConfidence(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clampConfidence(value);
  }
  if (typeof value !== 'string') return 0;
  const raw = value.trim().toLowerCase();
  if (!raw) return 0;
  if (raw === 'high') return 0.85;
  if (raw === 'medium') return 0.65;
  if (raw === 'low') return 0.35;
  const numeric = Number(raw.replace(/%$/, ''));
  if (!Number.isFinite(numeric)) return 0;
  return clampConfidence(raw.endsWith('%') ? numeric / 100 : numeric);
}

export function recordInvestigationCheck(
  state: InvestigationWorkingState,
  check: Omit<InvestigationCheck, 'id'> & { id?: string },
): InvestigationCheck {
  const saved: InvestigationCheck = {
    ...check,
    id: check.id || `check_${state.checks.length + 1}`,
  };
  state.checks.push(saved);

  const existing = state.hypotheses.find(
    (h) => h.text.trim().toLowerCase() === saved.hypothesis.trim().toLowerCase(),
  );
  if (existing) {
    existing.status = mergeHypothesisStatus(existing.status, saved.status);
    if (!existing.evidenceCheckIds.includes(saved.id)) {
      existing.evidenceCheckIds.push(saved.id);
    }
  } else {
    state.hypotheses.push({
      text: saved.hypothesis,
      status: saved.status,
      evidenceCheckIds: [saved.id],
    });
  }

  return saved;
}

export function evaluateInvestigationReadiness(
  input: InvestigationReadinessInput,
): InvestigationReadinessResult {
  const checks = input.state.checks;
  const claim = input.claim;
  const rootCause = claim.rootCause;
  const combinedText = [
    input.question,
    input.summary,
    input.sectionsText,
    rootCause.object,
    rootCause.field,
    rootCause.cause,
    rootCause.nextCheck,
  ].filter(Boolean).join('\n');

  if (checks.length === 0) {
    return block('Record each major diagnostic read with investigation_record_check before completing. The investigation has no structured checks, so the loop cannot tell what was tested or what remains unknown.');
  }

  if (rootCause.status === 'unresolved') {
    if (!rootCause.nextCheck && !claim.nextAction) {
      return block('If the root cause is unresolved, name the exact next check or external data needed. Do not finish with a vague "keep investigating" conclusion.');
    }
    if (checks.length < 2) {
      return block('An unresolved investigation still needs at least two concrete checks before giving up, unless a tool or connector is unavailable and the report says so.');
    }
    return { ok: true };
  }

  if (claim.confidence < 0.8) {
    return block(`Confidence is ${Math.round(claim.confidence * 100)}%, below the 80% bar. Keep reducing uncertainty or mark the conclusion unresolved with a concrete next check.`);
  }

  if (!rootCause.object || !rootCause.cause) {
    return block('The claimed root cause must name the specific object and the causal mechanism. A symptom, metric name, or generic component is not enough.');
  }

  if (isSymptomOnly(rootCause.object, rootCause.cause, input.summary)) {
    return block('The claimed root cause still reads like a symptom. Continue until it names the changeable object/value/config/rollout underneath the symptom.');
  }

  const signalTypes = new Set(checks.map((c) => c.signalType));
  if (signalTypes.size < 2 && checks.length < 4) {
    return block('Use at least two independent signal types before claiming an 80% root cause. For example: metric breakdown plus logs, Kubernetes events, config, or recent changes.');
  }

  const supported = checks.filter((c) => c.status === 'supported');
  if (supported.length < 1) {
    return block('At least one recorded check must support the claimed root cause. Right now the check ledger only rules things out or remains inconclusive.');
  }

  const ruledOut = new Set([
    ...claim.ruledOut.map(normalizeKey),
    ...checks.filter((c) => c.status === 'ruled_out').map((c) => normalizeKey(c.hypothesis)),
  ].filter(Boolean));
  if (ruledOut.size < 1) {
    return block('Rule out at least one plausible alternative hypothesis before completing. Deep investigations show why the first plausible story is not just a coincidence.');
  }

  if (claim.evidenceRefs.length < 2 && checks.length >= 2) {
    return block('Reference at least two recorded checks in evidenceRefs so the conclusion is tied to the diagnostic ledger.');
  }

  const serviceSide = SERVICE_SIDE_SYMPTOM_RX.test(combinedText);
  if (input.hasOpsConnector && serviceSide && !hasAnySignal(signalTypes, ['kubernetes', 'log', 'config'])) {
    return block('A service-side symptom is present and an Ops connector is available. Check Kubernetes state, events, logs, or config before completing.');
  }

  return { ok: true };
}

function block(reason: string): InvestigationReadinessResult {
  return { ok: false, reason };
}

function clampConfidence(value: number): number {
  if (value > 1) return Math.max(0, Math.min(1, value / 100));
  return Math.max(0, Math.min(1, value));
}

function mergeHypothesisStatus(
  oldStatus: HypothesisStatus,
  newStatus: HypothesisStatus,
): HypothesisStatus {
  if (newStatus === 'supported') return 'supported';
  if (oldStatus === 'supported') return 'supported';
  if (newStatus === 'ruled_out') return 'ruled_out';
  return oldStatus === 'ruled_out' ? 'ruled_out' : 'inconclusive';
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function hasAnySignal(
  actual: Set<InvestigationSignalType>,
  expected: InvestigationSignalType[],
): boolean {
  return expected.some((signal) => actual.has(signal));
}

const SERVICE_SIDE_SYMPTOM_RX =
  /\b(crash(?:loop)?|crashloopbackoff|restarts?|not[-\s]?ready|5xx|http error|error rate|status(?:\s*code)?|connection refused|timeout|oomkilled|pod\s+(?:down|failed|pending|crashing)|sidecar)\b/i;

const SYMPTOM_ONLY_RX =
  /\b(5xx|http error|error rate|crash(?:loop)?|crashloopbackoff|pod crash|pod is crashing|not[-\s]?ready|timeout|connection refused|sidecar issue|no traffic|metric missing|metric is zero)\b/i;

const CHANGEABLE_RX =
  /\b(deployment|statefulset|daemonset|replicaset|configmap|secret|env(?:ironment)? variable|image|tag|command|args?|probe|readiness|liveness|port|selector|service|ingress|virtualservice|destinationrule|envoyfilter|serviceentry|certificate|cert|tls|mTLS|dns|quota|limit|request|node pressure|exit code|rollout|deploy|commit|version|memory|cpu|owner|reason:|message:)\b/i;

function isSymptomOnly(object: string, cause: string, summary: string): boolean {
  const conclusion = [object, cause].join(' ');
  if (CHANGEABLE_RX.test(conclusion)) return false;
  return SYMPTOM_ONLY_RX.test(conclusion) || SYMPTOM_ONLY_RX.test(summary);
}
