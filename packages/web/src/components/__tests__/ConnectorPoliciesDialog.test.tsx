/**
 * ConnectorPoliciesDialog tests.
 *
 * PR1 keeps only the pure-helper coverage. The full dialog UI is stubbed
 * pending PR3's rewrite of the Connectors page, so the SSR markup
 * assertions and the API-shape tests that referenced the old
 * `ConnectorTeamPolicy` (teamId / agentPolicy) shape have been removed.
 * PR3 will reintroduce the equivalent coverage against the new
 * subjectType/subjectId model.
 */

import { describe, it, expect } from 'vitest';
import {
  capabilitiesFor,
  canSubmitAdd,
  isValidCapability,
  parseScope,
} from '../ConnectorPoliciesDialog.js';

describe('parseScope', () => {
  it('treats empty input as null', () => {
    expect(parseScope('')).toEqual({ ok: true, value: null });
    expect(parseScope('   ')).toEqual({ ok: true, value: null });
  });
  it('accepts a JSON object', () => {
    expect(parseScope('{"env":"prod"}')).toEqual({
      ok: true,
      value: { env: 'prod' },
    });
  });
  it('rejects non-object JSON', () => {
    expect(parseScope('"prod"').ok).toBe(false);
    expect(parseScope('[1,2]').ok).toBe(false);
  });
  it('rejects invalid JSON', () => {
    expect(parseScope('{not json').ok).toBe(false);
  });
});

describe('canSubmitAdd', () => {
  const base = {
    subjectType: 'team' as const,
    subjectId: 't1',
    capability: 'metrics.query',
    humanPolicy: 'ask',
    scopeRaw: '',
  };
  it('enabled when all fields present', () => {
    expect(canSubmitAdd(base)).toBe(true);
  });
  it('disabled when capability missing', () => {
    expect(canSubmitAdd({ ...base, capability: '' })).toBe(false);
  });
  it('disabled when capability is malformed', () => {
    expect(canSubmitAdd({ ...base, capability: 'NotValid' })).toBe(false);
  });
  it('disabled when scope is invalid JSON', () => {
    expect(canSubmitAdd({ ...base, scopeRaw: '{bad' })).toBe(false);
  });
  it('enabled with valid scope JSON', () => {
    expect(canSubmitAdd({ ...base, scopeRaw: '{"a":1}' })).toBe(true);
  });
});

describe('capabilitiesFor', () => {
  it('returns the prometheus template capabilities', () => {
    expect(capabilitiesFor('prometheus')).toContain('metrics.query');
  });
  it('returns [] for unknown connector type', () => {
    expect(capabilitiesFor('not-a-real-connector')).toEqual([]);
  });
  it('returns the curated kubernetes superset', () => {
    const caps = capabilitiesFor('kubernetes');
    expect(caps).toContain('runtime.apply');
    expect(caps).toContain('runtime.exec');
    expect(caps).toContain('runtime.get');
  });
});

describe('isValidCapability', () => {
  it('accepts the <area>.<verb> shape', () => {
    expect(isValidCapability('runtime.apply')).toBe(true);
    expect(isValidCapability('metrics.query')).toBe(true);
    expect(isValidCapability('runtime.port_forward')).toBe(true);
  });
  it('rejects empty / malformed strings', () => {
    expect(isValidCapability('')).toBe(false);
    expect(isValidCapability('runtime')).toBe(false);
    expect(isValidCapability('Runtime.Apply')).toBe(false);
    expect(isValidCapability('runtime.')).toBe(false);
    expect(isValidCapability('.apply')).toBe(false);
    expect(isValidCapability('runtime.apply.x')).toBe(false);
    expect(isValidCapability('runtime apply')).toBe(false);
  });
});
