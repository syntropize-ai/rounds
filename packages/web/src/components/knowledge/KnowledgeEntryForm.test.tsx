/**
 * Helper tests for KnowledgeEntryForm. The web vitest env is node-only, so
 * we cover the pure parsing/validation/round-trip helpers — not clicks.
 */
import { describe, it, expect } from 'vitest';
import type { KnowledgeEntry } from '@agentic-obs/common';
import {
  parseTagsInput,
  validateForm,
  entryToFormState,
  formStateToCreateBody,
  formStateToUpdateBody,
} from './KnowledgeEntryForm.js';

describe('parseTagsInput', () => {
  it('returns [] for empty / whitespace input', () => {
    expect(parseTagsInput('')).toEqual([]);
    expect(parseTagsInput('   ,  ,')).toEqual([]);
  });

  it('trims and splits comma-separated tags', () => {
    expect(parseTagsInput('a, b ,c')).toEqual(['a', 'b', 'c']);
  });

  it('dedupes while preserving order', () => {
    expect(parseTagsInput('alpha, beta, alpha, gamma, beta')).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });
});

describe('validateForm', () => {
  it('requires non-blank title', () => {
    const r = validateForm({ title: '  ', description: 'd', body: 'b' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/title/i);
  });

  it('requires non-blank description', () => {
    const r = validateForm({ title: 't', description: '   ', body: 'b' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/description/i);
  });

  it('accepts empty body (stub skills allowed)', () => {
    expect(validateForm({ title: 't', description: 'd', body: '' })).toEqual({
      ok: true,
    });
  });

  it('accepts a full filled form', () => {
    expect(
      validateForm({ title: 't', description: 'd', body: '## section' }),
    ).toEqual({ ok: true });
  });
});

describe('entryToFormState', () => {
  it('returns blank state for undefined entry', () => {
    expect(entryToFormState(undefined)).toEqual({
      title: '',
      description: '',
      body: '',
      tags: '',
      sourceRef: '',
    });
  });

  it('round-trips an existing entry', () => {
    const entry: KnowledgeEntry = {
      id: 'e1',
      orgId: 'org',
      source: 'saved',
      sourceRef: 'https://example.com',
      title: 'My skill',
      description: 'when to use',
      body: '## hi',
      intentTags: ['a', 'b'],
      useCount: 0,
      approvedCount: 0,
      rejectedCount: 0,
      createdBy: null,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    };
    expect(entryToFormState(entry)).toEqual({
      title: 'My skill',
      description: 'when to use',
      body: '## hi',
      tags: 'a, b',
      sourceRef: 'https://example.com',
    });
  });

  it('renders null sourceRef as empty string', () => {
    const entry: KnowledgeEntry = {
      id: 'e1',
      orgId: 'org',
      source: 'saved',
      sourceRef: null,
      title: 't',
      description: 'd',
      body: '',
      intentTags: [],
      useCount: 0,
      approvedCount: 0,
      rejectedCount: 0,
      createdBy: null,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    };
    expect(entryToFormState(entry).sourceRef).toBe('');
    expect(entryToFormState(entry).tags).toBe('');
  });
});

describe('formStateToCreateBody', () => {
  it('trims title/description and parses tags', () => {
    const body = formStateToCreateBody({
      title: '  My skill  ',
      description: '  use it  ',
      body: '## body',
      tags: 'a, b, a',
      sourceRef: '  https://x  ',
    });
    expect(body).toEqual({
      title: 'My skill',
      description: 'use it',
      body: '## body',
      intentTags: ['a', 'b'],
      sourceRef: 'https://x',
    });
  });

  it('sends null sourceRef when blank', () => {
    const body = formStateToCreateBody({
      title: 't',
      description: 'd',
      body: '',
      tags: '',
      sourceRef: '   ',
    });
    expect(body.sourceRef).toBeNull();
    expect(body.intentTags).toEqual([]);
  });

  it('does not include a kind field', () => {
    const body = formStateToCreateBody({
      title: 't',
      description: 'd',
      body: '',
      tags: '',
      sourceRef: '',
    });
    expect(body).not.toHaveProperty('kind');
    expect(body).not.toHaveProperty('content');
  });
});

describe('formStateToUpdateBody', () => {
  it('produces the same skill-style shape', () => {
    const u = formStateToUpdateBody({
      title: 't',
      description: 'd',
      body: 'b',
      tags: 'x',
      sourceRef: '',
    });
    expect(u).toEqual({
      title: 't',
      description: 'd',
      body: 'b',
      intentTags: ['x'],
      sourceRef: null,
    });
  });
});
