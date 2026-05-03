import { describe, expect, it } from 'vitest';
import { computeAlertFingerprint } from './fingerprint.js';

describe('computeAlertFingerprint', () => {
  it('returns the same hash for identical inputs', () => {
    const a = computeAlertFingerprint('rule-1', { host: 'h1', region: 'us' });
    const b = computeAlertFingerprint('rule-1', { host: 'h1', region: 'us' });
    expect(a).toBe(b);
  });

  it('is independent of label insertion order', () => {
    const a = computeAlertFingerprint('rule-1', { host: 'h1', region: 'us' });
    const b = computeAlertFingerprint('rule-1', { region: 'us', host: 'h1' });
    expect(a).toBe(b);
  });

  it('produces a different hash for a different ruleId', () => {
    const labels = { host: 'h1' };
    const a = computeAlertFingerprint('rule-1', labels);
    const b = computeAlertFingerprint('rule-2', labels);
    expect(a).not.toBe(b);
  });

  it('produces a different hash for different labels', () => {
    const a = computeAlertFingerprint('rule-1', { host: 'h1' });
    const b = computeAlertFingerprint('rule-1', { host: 'h2' });
    expect(a).not.toBe(b);
  });

  it('returns a hex sha256 string (64 chars)', () => {
    const fp = computeAlertFingerprint('rule-1', { host: 'h1' });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});
