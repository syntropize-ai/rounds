import { describe, it, expect } from 'vitest';
import { hashVariables, canonicalizeVariables } from './variable-hash.js';

describe('hashVariables', () => {
  it('produces the same hash regardless of key order', () => {
    const a = hashVariables({ service: 'ingress', namespace: 'prod' });
    const b = hashVariables({ namespace: 'prod', service: 'ingress' });
    expect(a).toBe(b);
  });

  it('changes when any value changes', () => {
    const a = hashVariables({ service: 'ingress', namespace: 'prod' });
    const b = hashVariables({ service: 'ingress', namespace: 'staging' });
    expect(a).not.toBe(b);
  });

  it('changes when a key is added', () => {
    const a = hashVariables({ service: 'ingress' });
    const b = hashVariables({ service: 'ingress', namespace: 'prod' });
    expect(a).not.toBe(b);
  });

  it('drops keys with empty-string values', () => {
    const a = hashVariables({ service: 'ingress' });
    const b = hashVariables({ service: 'ingress', namespace: '' });
    expect(a).toBe(b);
  });

  it('canonicalizes to sorted JSON', () => {
    expect(canonicalizeVariables({ b: '2', a: '1' })).toBe('{"a":"1","b":"2"}');
  });

  it('returns 8 hex chars', () => {
    expect(hashVariables({ x: 'y' })).toMatch(/^[0-9a-f]{8}$/);
  });

  it('treats {} as a stable hash', () => {
    expect(hashVariables({})).toBe(hashVariables({}));
    expect(canonicalizeVariables({})).toBe('{}');
  });
});
