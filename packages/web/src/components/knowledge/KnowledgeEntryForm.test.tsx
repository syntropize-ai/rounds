/**
 * Helper tests for KnowledgeEntryForm. The web vitest env is node-only, so
 * we cover the pure parsing/formatting helpers — not click interactions.
 */
import { describe, it, expect } from 'vitest';
import {
  parseTags,
  parseJsonContent,
  formatContentForEdit,
} from './KnowledgeEntryForm.js';

describe('parseTags', () => {
  it('returns [] for empty / whitespace input', () => {
    expect(parseTags('')).toEqual([]);
    expect(parseTags('   ,  ,')).toEqual([]);
  });

  it('trims and splits comma-separated tags', () => {
    expect(parseTags('a, b ,c')).toEqual(['a', 'b', 'c']);
  });

  it('dedupes while preserving order', () => {
    expect(parseTags('alpha, beta, alpha, gamma, beta')).toEqual(['alpha', 'beta', 'gamma']);
  });
});

describe('parseJsonContent', () => {
  it('treats empty input as {}', () => {
    expect(parseJsonContent('')).toEqual({ ok: true, value: {} });
    expect(parseJsonContent('   \n')).toEqual({ ok: true, value: {} });
  });

  it('parses valid JSON objects + arrays', () => {
    expect(parseJsonContent('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonContent('[1,2,3]')).toEqual({ ok: true, value: [1, 2, 3] });
  });

  it('returns an error message on invalid JSON', () => {
    const r = parseJsonContent('{bad json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(typeof r.message).toBe('string');
  });
});

describe('formatContentForEdit', () => {
  it('formats objects with 2-space indent', () => {
    expect(formatContentForEdit({ a: 1, b: 'x' })).toBe('{\n  "a": 1,\n  "b": "x"\n}');
  });

  it('returns empty string for null / undefined', () => {
    expect(formatContentForEdit(null)).toBe('');
    expect(formatContentForEdit(undefined)).toBe('');
  });
});
