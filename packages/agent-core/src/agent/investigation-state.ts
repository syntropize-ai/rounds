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

/**
 * The four kinds of read the product can prove actually happened.
 *
 * Each maps to a counter in `recordInvestigationRead`, so for a check citing
 * one of these tools we can say whether a call went out and whether its source
 * answered. Everything else — a trace viewer, a runbook, a web page — is real
 * evidence to a human reader but is only the model's word to us.
 */
export type ReadFamily = 'metric' | 'log' | 'ops' | 'change';

/**
 * Which read a check's cited tool draws on, or null when nothing backs it.
 *
 * Resolved from the tool name first and the declared signal type only as a
 * fallback, because the tool is what actually ran and the signal type is a
 * label the model chose. A check tagged `config` that cites `ops_run_command`
 * did the work; a check tagged `metric` that cites a tool we have never heard
 * of did not.
 *
 * Shared by the record-time check and the evidence gate on purpose. When these
 * two disagreed, the gate credited independence the ledger had not verified.
 */
export function readFamilyForTool(
  tool: string,
  signalType: InvestigationSignalType,
): ReadFamily | null {
  const t = tool.trim().toLowerCase();
  if (t.startsWith('metrics_')) return 'metric';
  if (t.startsWith('logs_')) return 'log';
  if (t === 'ops_run_command' || t === 'ops_cluster_shell') return 'ops';
  if (t === 'changes_list_recent') return 'change';
  // A tool name the agent invented rather than called. Fall back to the
  // declared signal type so a check claiming metric evidence still needs a
  // metric read behind it.
  if (signalType === 'metric') return 'metric';
  if (signalType === 'log') return 'log';
  if (signalType === 'kubernetes') return 'ops';
  if (signalType === 'change') return 'change';
  return null;
}

/**
 * One read that actually executed, in the order it ran.
 *
 * `record_check` consumes one of these per recorded check, which is what stops
 * the ledger filling up with checks describing work that never happened.
 *
 * Declared once and shared. This shape was written out longhand in three
 * places, and adding a field to one of them was how the drift showed up — the
 * same failure that let the gate and the record-time check disagree about what
 * counted as an independent signal.
 */
export interface InvestigationRead {
  action: string;
  family: ReadFamily;
  /**
   * Whether the source answered at all. A source that could not be consulted
   * reports nothing, which is not the same as reporting nothing found.
   */
  sourceAnswered: boolean;
  consumed: boolean;
}

export type HypothesisStatus = 'supported' | 'ruled_out' | 'inconclusive';

/**
 * What the check actually covers. Recorded as structured fields because the
 * evidence gate has to know it without reading the narrative: prose is written
 * in the user's language, so any keyword match over `result`/`interpretation`
 * is both English-only and trivially satisfiable. At least one of the two is
 * required at record time (`handleInvestigationRecordCheck`).
 */
export interface InvestigationCheckScope {
  timeWindow?: string;
  affected?: string;
}

export interface InvestigationCheck {
  id: string;
  hypothesis: string;
  signalType: InvestigationSignalType;
  tool: string;
  query: string;
  result: string;
  interpretation: string;
  status: HypothesisStatus;
  scope: InvestigationCheckScope;
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
  validationMethod?: string;
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
