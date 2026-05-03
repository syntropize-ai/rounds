import { describe, expect, it } from 'vitest';
import {
  parseScope,
  scopeCovers,
  buildScope,
  normalizeScope,
  parseApprovalScope,
  isValidApprovalScope,
  approvalRowScopes,
} from './scope.js';

describe('parseScope', () => {
  it('parses kind:attribute:identifier', () => {
    expect(parseScope('dashboards:uid:abc')).toEqual({
      kind: 'dashboards',
      attribute: 'uid',
      identifier: 'abc',
    });
  });

  it('defaults missing segments to wildcard', () => {
    expect(parseScope('dashboards:*')).toEqual({
      kind: 'dashboards',
      attribute: '*',
      identifier: '*',
    });
  });

  it('empty string parses as all wildcards', () => {
    expect(parseScope('')).toEqual({ kind: '*', attribute: '*', identifier: '*' });
  });

  it('identifier can contain colons', () => {
    expect(parseScope('alert.rules:uid:group:abc')).toEqual({
      kind: 'alert.rules',
      attribute: 'uid',
      identifier: 'group:abc',
    });
  });
});

describe('scopeCovers', () => {
  it('empty parent covers anything', () => {
    expect(scopeCovers('', 'dashboards:uid:abc')).toBe(true);
    expect(scopeCovers('', '')).toBe(true);
  });

  it('exact match covers', () => {
    expect(scopeCovers('dashboards:uid:abc', 'dashboards:uid:abc')).toBe(true);
  });

  it('wildcard kind covers any child', () => {
    expect(scopeCovers('*', 'dashboards:uid:abc')).toBe(true);
  });

  it('kind:* covers any attribute/identifier in that kind', () => {
    expect(scopeCovers('dashboards:*', 'dashboards:uid:abc')).toBe(true);
    expect(scopeCovers('dashboards:*', 'dashboards:uid:def')).toBe(true);
  });

  it('kind:attribute:* covers all identifiers of that attribute', () => {
    expect(scopeCovers('dashboards:uid:*', 'dashboards:uid:abc')).toBe(true);
    // But not a different attribute.
    expect(scopeCovers('dashboards:uid:*', 'dashboards:id:42')).toBe(false);
  });

  it('different kind never covers', () => {
    expect(scopeCovers('folders:uid:*', 'dashboards:uid:abc')).toBe(false);
  });

  it('narrower parent does not cover broader child', () => {
    expect(scopeCovers('dashboards:uid:abc', 'dashboards:uid:def')).toBe(false);
    expect(scopeCovers('dashboards:uid:abc', 'dashboards:*')).toBe(false);
  });

  it('buildScope produces the conventional three-segment form', () => {
    expect(buildScope('dashboards')).toBe('dashboards:*:*');
    expect(buildScope('dashboards', 'uid', 'abc')).toBe('dashboards:uid:abc');
  });

  it('normalizeScope converts null/undefined to empty string', () => {
    expect(normalizeScope(null)).toBe('');
    expect(normalizeScope(undefined)).toBe('');
    expect(normalizeScope('dashboards:*')).toBe('dashboards:*');
  });
});

describe('parseApprovalScope', () => {
  it('parses the three new shapes plus uid + wildcard', () => {
    expect(parseApprovalScope('approvals:*')).toEqual({ kind: 'wildcard' });
    expect(parseApprovalScope('approvals:uid:abc-123')).toEqual({ kind: 'uid', id: 'abc-123' });
    expect(parseApprovalScope('approvals:connector:prod-eks')).toEqual({
      kind: 'connector',
      connectorId: 'prod-eks',
    });
    expect(parseApprovalScope('approvals:namespace:prod-eks:platform')).toEqual({
      kind: 'namespace',
      connectorId: 'prod-eks',
      ns: 'platform',
    });
    expect(parseApprovalScope('approvals:team:t_42')).toEqual({ kind: 'team', teamId: 't_42' });
  });

  it('preserves dashes / underscores in connector and team ids', () => {
    expect(parseApprovalScope('approvals:connector:dev_eks-east-1')).toEqual({
      kind: 'connector',
      connectorId: 'dev_eks-east-1',
    });
  });

  it('rejects malformed shapes (returns null)', () => {
    // missing namespace
    expect(parseApprovalScope('approvals:namespace:prod')).toBeNull();
    // empty identifier
    expect(parseApprovalScope('approvals:uid:')).toBeNull();
    expect(parseApprovalScope('approvals:connector:')).toBeNull();
    expect(parseApprovalScope('approvals:team:')).toBeNull();
    expect(parseApprovalScope('approvals:namespace::platform')).toBeNull();
    expect(parseApprovalScope('approvals:namespace:prod-eks:')).toBeNull();
    // unknown attribute
    expect(parseApprovalScope('approvals:cluster:prod')).toBeNull();
    // too many segments
    expect(parseApprovalScope('approvals:namespace:prod:platform:extra')).toBeNull();
    // wrong kind
    expect(parseApprovalScope('dashboards:uid:abc')).toBeNull();
  });

  it('isValidApprovalScope is the boolean projection of parse', () => {
    expect(isValidApprovalScope('approvals:*')).toBe(true);
    expect(isValidApprovalScope('approvals:namespace:prod-eks:platform')).toBe(true);
    expect(isValidApprovalScope('approvals:namespace:prod')).toBe(false);
    expect(isValidApprovalScope('garbage')).toBe(false);
  });
});

describe('approvalRowScopes', () => {
  it('full row → uid + connector + nsPair + team (4 entries, NEVER approvals:*)', () => {
    const out = approvalRowScopes({
      id: 'app-1',
      opsConnectorId: 'prod-eks',
      targetNamespace: 'platform',
      requesterTeamId: 't-platform',
    });
    expect(out).toEqual([
      'approvals:uid:app-1',
      'approvals:connector:prod-eks',
      'approvals:namespace:prod-eks:platform',
      'approvals:team:t-platform',
    ]);
    expect(out).not.toContain('approvals:*');
  });

  it('NULL connector → omits connector and namespace entries', () => {
    const out = approvalRowScopes({
      id: 'app-2',
      opsConnectorId: null,
      targetNamespace: null,
      requesterTeamId: 't-platform',
    });
    expect(out).toEqual(['approvals:uid:app-2', 'approvals:team:t-platform']);
  });

  it('connector present but NULL namespace → omits the nsPair entry', () => {
    const out = approvalRowScopes({
      id: 'app-3',
      opsConnectorId: 'prod-eks',
      targetNamespace: null,
      requesterTeamId: null,
    });
    expect(out).toEqual(['approvals:uid:app-3', 'approvals:connector:prod-eks']);
  });

  it('id-only row → just the uid scope', () => {
    expect(approvalRowScopes({ id: 'app-4' })).toEqual(['approvals:uid:app-4']);
  });
});
