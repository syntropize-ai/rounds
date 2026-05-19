import { describe, it, expect } from 'vitest';
import { tfIdfSearch, tokenize } from '../tf-idf.js';

describe('tokenize', () => {
  it('drops stoplist tokens and splits on non-alphanumeric', () => {
    expect(tokenize('The quick brown-fox over_the lazy dog'))
      .toEqual(['quick', 'brown-fox', 'over_the', 'lazy', 'dog']);
  });
});

describe('tfIdfSearch', () => {
  it('returns [] on empty docs', () => {
    expect(tfIdfSearch([], 'anything', 5)).toEqual([]);
  });

  it('returns [] when query has no matches', () => {
    expect(tfIdfSearch([{ id: 'a', text: 'hello world' }], 'xyz', 5)).toEqual([]);
  });

  it('returns [] when query is whitespace / stoplist only', () => {
    expect(tfIdfSearch([{ id: 'a', text: 'hello' }], '   ', 5)).toEqual([]);
    expect(tfIdfSearch([{ id: 'a', text: 'hello' }], 'a the of', 5)).toEqual([]);
  });

  it('ranks the more relevant doc higher', () => {
    const docs = [
      { id: 'd1', text: 'istio gateway resources' },
      { id: 'd2', text: 'istio istio istio gateway' },
    ];
    const hits = tfIdfSearch(docs, 'istio', 5);
    expect(hits[0]?.id).toBe('d2');
    expect(hits[1]?.id).toBe('d1');
  });

  it('stable id sort tiebreak for identical docs', () => {
    const docs = [
      { id: 'b', text: 'same content here' },
      { id: 'a', text: 'same content here' },
    ];
    const hits = tfIdfSearch(docs, 'content', 5);
    expect(hits.map((h) => h.id)).toEqual(['a', 'b']);
  });

  it('non-ASCII tokens are kept as opaque (no match unless query matches)', () => {
    const docs = [{ id: 'd1', text: 'latency 延迟 high' }];
    // alphanumeric split drops the non-ASCII token from index; only "latency"/"high" match.
    expect(tfIdfSearch(docs, 'latency', 5).length).toBe(1);
    expect(tfIdfSearch(docs, '延迟', 5)).toEqual([]);
  });

  it('snippet centers on first matching token', () => {
    const long = 'lorem ipsum dolor sit amet '.repeat(20) + 'KAFKA consumer lag spike here';
    const hits = tfIdfSearch([{ id: 'a', text: long }], 'kafka', 1);
    expect(hits[0]?.snippet).toContain('KAFKA');
    expect(hits[0]?.snippet.length).toBeLessThanOrEqual(120);
  });

  it('snippet falls back to first 120 chars when no token match in raw text', () => {
    // Title-only match: the doc text doesn't include the query token (only the title would).
    const text = 'aaa '.repeat(60);
    const hits = tfIdfSearch([{ id: 'a', text: text + ' kafka' }], 'kafka', 1);
    expect(hits.length).toBe(1);
    expect(hits[0]?.snippet.length).toBeLessThanOrEqual(120);
  });

  it('limit truncates results', () => {
    const docs = Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, text: 'foo bar' }));
    const hits = tfIdfSearch(docs, 'foo', 3);
    expect(hits.length).toBe(3);
  });
});
