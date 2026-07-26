/**
 * An unrecognised status must never be presented as healthy progress.
 *
 * Two halves of the same defect. The style map fell back to `planning`, so a
 * status this build did not know rendered as a blue "Planning" pill saying
 * "Planning investigation steps…". And the list's active check was written as
 * "not completed and not failed", so the same unknown status was polled every
 * five seconds forever — the UI insisting something was working on it.
 *
 * Both now fail towards "I don't know" rather than towards "it's fine".
 */

import { describe, it, expect } from 'vitest';
import { getInvestigationStatusStyle, DEFAULT_INVESTIGATION_STATUS } from './status-styles.js';
import { isActive } from '../pages/Investigations.js';

describe('unrecognised investigation status', () => {
  it('does not render as an in-progress state', () => {
    const unknown = getInvestigationStatusStyle('cancelled_by_operator');
    expect(unknown.label).toBe('Unknown');
    expect(unknown).toBe(DEFAULT_INVESTIGATION_STATUS);
    // Specifically not the old fallback, which claimed work was underway.
    expect(unknown.label).not.toBe(getInvestigationStatusStyle('planning').label);
    expect(unknown.description.toLowerCase()).not.toContain('planning');
  });

  it('still resolves every status the product actually produces', () => {
    for (const status of [
      'planning', 'investigating', 'evidencing', 'explaining',
      'acting', 'verifying', 'completed', 'failed',
    ]) {
      expect(getInvestigationStatusStyle(status).label, status).not.toBe('Unknown');
    }
  });

  it('is not polled forever', () => {
    expect(isActive('cancelled_by_operator')).toBe(false);
    expect(isActive('')).toBe(false);
  });

  it('still polls the states that really are in flight', () => {
    for (const status of ['planning', 'investigating', 'evidencing', 'explaining', 'acting', 'verifying']) {
      expect(isActive(status), status).toBe(true);
    }
    expect(isActive('completed')).toBe(false);
    expect(isActive('failed')).toBe(false);
  });
});
