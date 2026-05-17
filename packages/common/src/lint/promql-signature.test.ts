import { describe, it, expect } from 'vitest';
import { querySignature } from './promql-signature.js';

describe('querySignature', () => {
  it('collapses different filter values to the same signature', () => {
    const a = querySignature('sum(rate(http_requests_total{app="foo"}[5m]))');
    const b = querySignature('sum(rate(http_requests_total{app="bar"}[5m]))');
    expect(a).toBe(b);
  });

  it('keeps different range windows distinct', () => {
    const a = querySignature('sum(rate(http_requests_total[5m]))');
    const b = querySignature('sum(rate(http_requests_total[1m]))');
    expect(a).not.toBe(b);
  });

  it('is invariant to selector label order', () => {
    const a = querySignature('sum(rate(http_requests_total{app="foo",ns="prod"}[5m]))');
    const b = querySignature('sum(rate(http_requests_total{ns="prod",app="foo"}[5m]))');
    expect(a).toBe(b);
  });

  it('strips comments and collapses whitespace runs', () => {
    // Spec only requires whitespace *runs* collapse to a single space; it
    // does NOT require deleting spaces between tokens. So `sum( rate(...` is
    // normalized to `sum( rate(...` (single-spaced), and the trailing
    // comment is removed.
    const a = querySignature('  sum(rate(http_requests_total[5m]))   # noisy comment');
    const b = querySignature('sum(rate(http_requests_total[5m]))');
    expect(a).toBe(b);
    expect(querySignature('foo  bar')).toBe('foo bar');
  });

  it('handles regex match operators and single quotes', () => {
    const a = querySignature(`up{job=~'prod-.*'}`);
    const b = querySignature(`up{job=~"staging-foo"}`);
    expect(a).toBe(b);
  });

  it('returns empty string for empty input', () => {
    expect(querySignature('')).toBe('');
  });

  it('different metric names produce different signatures', () => {
    const a = querySignature('rate(http_requests_total[5m])');
    const b = querySignature('rate(grpc_requests_total[5m])');
    expect(a).not.toBe(b);
  });

  it('selector with no filters round-trips as empty braces', () => {
    const a = querySignature('http_requests_total{}');
    expect(a).toBe('http_requests_total{}');
  });
});
