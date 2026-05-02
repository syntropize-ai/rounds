import { describe, expect, it } from 'vitest';
import {
  classifyInvestigation,
  IN_PROGRESS_INVESTIGATION_STATUSES,
  nextPollIntervalMs,
} from './alerts-investigation-status.js';

describe('classifyInvestigation', () => {
  it('returns idle when no investigation has been kicked off', () => {
    expect(classifyInvestigation({})).toEqual({ kind: 'idle' });
  });

  it('returns in_progress for active statuses', () => {
    for (const status of IN_PROGRESS_INVESTIGATION_STATUSES) {
      expect(classifyInvestigation({ investigationId: 'i1', status })).toEqual({
        kind: 'in_progress',
        status,
        investigationId: 'i1',
      });
    }
  });

  it('returns failed for failed investigations', () => {
    expect(classifyInvestigation({ investigationId: 'i1', status: 'failed' })).toEqual({
      kind: 'failed',
      investigationId: 'i1',
    });
  });

  it('returns completed_with_plan when a pending plan exists', () => {
    expect(
      classifyInvestigation({ investigationId: 'i1', status: 'completed', pendingPlanId: 'p1' }),
    ).toEqual({ kind: 'completed_with_plan', investigationId: 'i1', planId: 'p1' });
  });

  it('returns completed when finished without a plan', () => {
    expect(classifyInvestigation({ investigationId: 'i1', status: 'completed' })).toEqual({
      kind: 'completed',
      investigationId: 'i1',
    });
  });

  it('falls back to in_progress when status is not yet loaded but id exists', () => {
    expect(classifyInvestigation({ investigationId: 'i1' })).toEqual({
      kind: 'in_progress',
      status: 'planning',
      investigationId: 'i1',
    });
  });
});

describe('nextPollIntervalMs', () => {
  it('uses 5s while a visible page has any active investigation', () => {
    expect(nextPollIntervalMs({ anyActive: true, visible: true })).toBe(5_000);
  });

  it('backs off to 30s when nothing is active', () => {
    expect(nextPollIntervalMs({ anyActive: false, visible: true })).toBe(30_000);
  });

  it('backs off when the document is hidden, even with active work', () => {
    expect(nextPollIntervalMs({ anyActive: true, visible: false })).toBe(30_000);
  });
});
