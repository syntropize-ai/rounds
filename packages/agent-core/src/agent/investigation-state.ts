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
}

export function createInvestigationWorkingState(): InvestigationWorkingState {
  return {
    checks: [],
    hypotheses: [],
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
