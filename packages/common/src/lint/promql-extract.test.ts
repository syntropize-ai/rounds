import { describe, it, expect } from 'vitest';
import {
  extractAggregationClauses,
  extractMetricSelectors,
  extractRangeVectors,
  normalizeQuery,
  rangeTokenToSeconds,
} from './promql-extract.js';

describe('extractMetricSelectors', () => {
  it('pulls metric + label selectors out of a basic query', () => {
    const out = extractMetricSelectors('http_requests_total{method="GET", status="200"}');
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('http_requests_total');
    expect(out[0]!.selectors.map((s) => s.label).sort()).toEqual(['method', 'status']);
  });

  it('handles regex matchers and negation', () => {
    const out = extractMetricSelectors('up{instance!~"foo.*"}');
    expect(out[0]!.selectors[0]).toMatchObject({ label: 'instance', op: '!~', value: 'foo.*' });
  });

  it('skips function names', () => {
    const out = extractMetricSelectors('sum(rate(http_requests_total[5m]))');
    const names = out.map((m) => m.name);
    expect(names).toContain('http_requests_total');
    expect(names).not.toContain('sum');
    expect(names).not.toContain('rate');
  });
});

describe('extractAggregationClauses', () => {
  it('captures by-clauses', () => {
    const out = extractAggregationClauses('sum(rate(x[5m])) by (pod, namespace)');
    expect(out).toEqual([{ kind: 'by', labels: ['pod', 'namespace'] }]);
  });
  it('captures without-clauses', () => {
    const out = extractAggregationClauses('sum without (instance) (x)');
    expect(out).toEqual([{ kind: 'without', labels: ['instance'] }]);
  });
});

describe('extractRangeVectors / rangeTokenToSeconds', () => {
  it('extracts every [duration] token', () => {
    expect(extractRangeVectors('rate(x[5m]) + rate(y[30s])')).toEqual(['5m', '30s']);
  });
  it('converts duration tokens to seconds', () => {
    expect(rangeTokenToSeconds('5m')).toBe(300);
    expect(rangeTokenToSeconds('1h')).toBe(3600);
    expect(rangeTokenToSeconds('garbage')).toBeNaN();
  });
});

describe('normalizeQuery', () => {
  it('collapses whitespace', () => {
    expect(normalizeQuery('sum(  rate( x[5m] ) )')).toBe('sum( rate( x[5m] ) )');
  });
});
