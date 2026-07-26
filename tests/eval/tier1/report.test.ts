/**
 * These pin the denominator boundary. Every case below is a run the product
 * handled badly; each one must stay graded rather than drifting into INVALID,
 * because INVALID runs leave the denominator and a product's worst runs are
 * exactly the ones it is tempting to lose.
 */

import { describe, it, expect } from 'vitest';
import { toScoredReport } from './report.js';
import { score, type GroundTruth } from '../scoring/score.js';

const TRUTH: GroundTruth = {
  id: 't',
  objectMustMatch: ['reviews-v2'],
  mechanism: 'a fixed delay was injected',
};

describe('toScoredReport', () => {
  it('grades a report that never reached a gate result as unresolved, not missing', () => {
    // The agent answered in prose and never completed a structured
    // investigation. That is a product failure and belongs in the denominator.
    expect(score(toScoredReport({ provenance: {} }), TRUTH).outcome).toBe('UNRESOLVED');
    expect(score(toScoredReport(null), TRUTH).outcome).toBe('UNRESOLVED');
  });

  it('carries a passed gate through with its root cause intact', () => {
    const s = toScoredReport({
      provenance: {
        rootCauseGate: {
          status: 'passed',
          rootCause: { status: 'confirmed', object: 'reviews-v2', cause: 'a delay was injected' },
          confidence: 0.9,
          ruledOut: ['ratings latency'],
        },
      },
    });
    expect(s.gateStatus).toBe('passed');
    expect(score(s, TRUTH).outcome).toBe('PARTIAL');
    expect(score(s, TRUTH).needsJudge?.reported).toBe('a delay was injected');
  });

  it('keeps a downgraded gate unresolved even when a root cause object survives on the record', () => {
    // The gate withheld the verdict but the model's proposed object is still
    // stored. Grading that object would credit an answer the operator was
    // never shown as a conclusion.
    const s = toScoredReport({
      provenance: {
        rootCauseGate: {
          status: 'unresolved',
          rootCause: { status: 'likely', object: 'reviews-v2' },
          confidence: 0.4,
        },
      },
    });
    expect(score(s, TRUTH).outcome).toBe('UNRESOLVED');
  });
});
