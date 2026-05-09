import { describe, expect, it } from 'vitest';
import {
  formatCost,
  formatLatency,
  shortenRunId,
} from './ProvenanceHeader.js';

describe('formatCost', () => {
  it('renders an em dash for missing values', () => {
    expect(formatCost(undefined)).toBe('—');
    expect(formatCost(null)).toBe('—');
    expect(formatCost(Number.NaN)).toBe('—');
  });

  it('formats zero, sub-cent, and standard amounts', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(0.0421)).toBe('$0.04');
    expect(formatCost(1.235)).toBe('$1.24');
  });
});

describe('formatLatency', () => {
  it('renders an em dash for missing values', () => {
    expect(formatLatency(undefined)).toBe('—');
    expect(formatLatency(null)).toBe('—');
    expect(formatLatency(Number.NaN)).toBe('—');
  });

  it('formats sub-second as ms and longer as seconds', () => {
    expect(formatLatency(0)).toBe('0ms');
    expect(formatLatency(450)).toBe('450ms');
    expect(formatLatency(999)).toBe('999ms');
    expect(formatLatency(22000)).toBe('22.0s');
    expect(formatLatency(22500)).toBe('22.5s');
  });
});

describe('shortenRunId', () => {
  it('returns em dash for missing run id', () => {
    expect(shortenRunId(undefined)).toBe('—');
  });
  it('passes short ids through and truncates long ones', () => {
    expect(shortenRunId('inv_abc')).toBe('inv_abc');
    expect(shortenRunId('inv_a1b2c3d4-e5f6-7890-ab12-345678901234')).toBe('inv_a1b2…');
  });
});
