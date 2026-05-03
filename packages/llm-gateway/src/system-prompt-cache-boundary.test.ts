import { describe, it, expect } from 'vitest';
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  stripCacheBoundary,
} from './system-prompt-cache-boundary.js';

describe('stripCacheBoundary', () => {
  it('returns the input unchanged when the marker is absent', () => {
    const text = 'You are an agent.\n\n# System\n- be helpful';
    expect(stripCacheBoundary(text)).toBe(text);
  });

  it('removes the marker when surrounded by newlines', () => {
    const text = `static intro\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n# Current Dashboard`;
    const out = stripCacheBoundary(text);
    expect(out).not.toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(out).toBe('static intro\n\n# Current Dashboard');
  });

  it('removes a marker that is the only content', () => {
    expect(stripCacheBoundary(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)).toBe('');
  });

  it('removes multiple occurrences if any slip through', () => {
    const text = `a${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}b${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}c`;
    const out = stripCacheBoundary(text);
    expect(out).not.toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(out).toBe('a\n\nb\n\nc');
  });

  it('preserves content before and after exactly when no surrounding newlines', () => {
    const text = `before${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}after`;
    expect(stripCacheBoundary(text)).toBe('before\n\nafter');
  });
});
