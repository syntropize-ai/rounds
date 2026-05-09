import { describe, expect, it } from 'vitest';
import { parseCitations } from './citation-parser.js';

describe('parseCitations', () => {
  it('returns a single text run for plain markdown with no citations', () => {
    const runs = parseCitations('CPU pegged at **100%** then `crashed`.');
    expect(runs).toEqual([
      { type: 'text', text: 'CPU pegged at **100%** then `crashed`.' },
    ]);
  });

  it('extracts a single citation chip surrounded by text', () => {
    const runs = parseCitations('CPU saturated [m1] across the fleet.');
    expect(runs).toEqual([
      { type: 'text', text: 'CPU saturated ' },
      { type: 'citation', ref: 'm1', kind: 'metric' },
      { type: 'text', text: ' across the fleet.' },
    ]);
  });

  it('extracts multiple citations and maps prefixes to kinds', () => {
    const runs = parseCitations('Logs [l2] tied to k8s rollout [k1] after change [c1].');
    expect(runs.filter((r) => r.type === 'citation')).toEqual([
      { type: 'citation', ref: 'l2', kind: 'log' },
      { type: 'citation', ref: 'k1', kind: 'k8s' },
      { type: 'citation', ref: 'c1', kind: 'change' },
    ]);
  });

  it('preserves bold, code, and link markdown around citations (only consumes [xN] tokens)', () => {
    const runs = parseCitations('**Spike** in `p99` [m1]: see [link](http://x).');
    // The bold/code/link spans land verbatim in text runs — InlineMarkdown's
    // bold/code passes will format them. The parser only ate `[m1]`.
    expect(runs).toEqual([
      { type: 'text', text: '**Spike** in `p99` ' },
      { type: 'citation', ref: 'm1', kind: 'metric' },
      { type: 'text', text: ': see [link](http://x).' },
    ]);
  });

  it('ignores bracketed tokens that are not citation-shaped', () => {
    const runs = parseCitations('[note] [todo] [m] [m1a] [foo1]');
    // None of those match `[mlkc]\d+` exactly — all stay in text.
    expect(runs).toEqual([{ type: 'text', text: '[note] [todo] [m] [m1a] [foo1]' }]);
  });

  it('handles back-to-back citations', () => {
    const runs = parseCitations('[m1][m2]');
    expect(runs).toEqual([
      { type: 'citation', ref: 'm1', kind: 'metric' },
      { type: 'citation', ref: 'm2', kind: 'metric' },
    ]);
  });
});
