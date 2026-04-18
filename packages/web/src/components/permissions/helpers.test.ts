import { describe, it, expect } from 'vitest';
import type { ResourcePermissionEntry } from '@agentic-obs/common';
import {
  resolveListEndpoint,
  resolveSetEndpoint,
  splitBuckets,
  entryToDraft,
  buildSavePayload,
  upsertDraft,
  draftKey,
  levelLabel,
  type DraftDirectEntry,
} from './helpers.js';

describe('permissions helpers — endpoint routing', () => {
  it('folders → /folders/:uid/permissions', () => {
    expect(resolveListEndpoint('folders', 'f1')).toBe('/folders/f1/permissions');
    expect(resolveSetEndpoint('folders', 'f1')).toBe('/folders/f1/permissions');
  });
  it('dashboards → /dashboards/uid/:uid/permissions', () => {
    expect(resolveListEndpoint('dashboards', 'abc-xyz')).toBe(
      '/dashboards/uid/abc-xyz/permissions',
    );
  });
  it('datasources → /datasources/:uid/permissions', () => {
    expect(resolveListEndpoint('datasources', 'prom-prod')).toBe(
      '/datasources/prom-prod/permissions',
    );
  });
  it('alert.rules → /access-control/alert.rules/:uid/permissions', () => {
    expect(resolveListEndpoint('alert.rules', 'folder-42')).toBe(
      '/access-control/alert.rules/folder-42/permissions',
    );
  });
  it('url-encodes uids with special characters', () => {
    expect(resolveListEndpoint('folders', 'a b/c')).toBe('/folders/a%20b%2Fc/permissions');
  });
});

describe('splitBuckets', () => {
  const entries: ResourcePermissionEntry[] = [
    {
      id: '1',
      roleName: 'managed:users:u1:permissions',
      isManaged: true,
      isInherited: false,
      userId: 'u1',
      userLogin: 'alice',
      userEmail: 'alice@co',
      permission: 2,
      actions: [],
    },
    {
      id: '2',
      roleName: 'managed:teams:t1:permissions',
      isManaged: true,
      isInherited: true,
      inheritedFrom: { type: 'folder', uid: 'parent', title: '/Engineering' },
      teamId: 't1',
      teamName: 'SRE',
      permission: 4,
      actions: [],
    },
    {
      id: '3',
      roleName: 'managed:builtins:Viewer:permissions',
      isManaged: true,
      isInherited: false,
      builtInRole: 'Viewer',
      permission: 1,
      actions: [],
    },
  ];

  it('sorts entries into inherited / direct', () => {
    const { inherited, direct } = splitBuckets(entries);
    expect(inherited).toHaveLength(1);
    expect(inherited[0]?.teamId).toBe('t1');
    expect(direct).toHaveLength(2);
    expect(direct.map((d) => d.id).sort()).toEqual(['1', '3']);
  });

  it('handles empty input', () => {
    const { inherited, direct } = splitBuckets([]);
    expect(inherited).toEqual([]);
    expect(direct).toEqual([]);
  });
});

describe('entryToDraft', () => {
  it('maps a user entry (prefers email label)', () => {
    const d = entryToDraft({
      id: '1',
      roleName: 'r',
      isManaged: true,
      isInherited: false,
      userId: 'u1',
      userLogin: 'alice',
      userEmail: 'alice@co',
      permission: 2,
      actions: [],
    });
    expect(d).toEqual({ kind: 'user', userId: 'u1', label: 'alice@co', level: 2 });
  });

  it('falls back to login if email missing', () => {
    const d = entryToDraft({
      id: '1',
      roleName: 'r',
      isManaged: true,
      isInherited: false,
      userId: 'u1',
      userLogin: 'bob',
      permission: 1,
      actions: [],
    });
    expect(d?.kind).toBe('user');
    expect(d?.label).toBe('bob');
  });

  it('maps a team entry', () => {
    const d = entryToDraft({
      id: '1',
      roleName: 'r',
      isManaged: true,
      isInherited: false,
      teamId: 't1',
      teamName: 'Platform',
      permission: 4,
      actions: [],
    });
    expect(d).toEqual({ kind: 'team', teamId: 't1', label: 'Platform', level: 4 });
  });

  it('maps a built-in role entry', () => {
    const d = entryToDraft({
      id: '1',
      roleName: 'r',
      isManaged: true,
      isInherited: false,
      builtInRole: 'Editor',
      permission: 2,
      actions: [],
    });
    expect(d).toEqual({ kind: 'role', role: 'Editor', label: 'Editor', level: 2 });
  });

  it('returns null for an entry with no principal', () => {
    const d = entryToDraft({
      id: '1',
      roleName: 'r',
      isManaged: true,
      isInherited: false,
      permission: 2,
      actions: [],
    });
    expect(d).toBeNull();
  });
});

describe('buildSavePayload', () => {
  it('serializes each draft type to the right item shape', () => {
    const drafts: DraftDirectEntry[] = [
      { kind: 'user', userId: 'u1', label: 'a', level: 2 },
      { kind: 'team', teamId: 't1', label: 't', level: 1 },
      { kind: 'role', role: 'Admin', label: 'Admin', level: 4 },
    ];
    const { items } = buildSavePayload(drafts);
    expect(items).toEqual([
      { userId: 'u1', permission: 2 },
      { teamId: 't1', permission: 1 },
      { role: 'Admin', permission: 4 },
    ]);
  });

  it('produces an empty list when nothing is drafted', () => {
    const { items } = buildSavePayload([]);
    expect(items).toEqual([]);
  });
});

describe('upsertDraft + draftKey', () => {
  it('adds a new draft when none matches', () => {
    const out = upsertDraft(
      [{ kind: 'role', role: 'Viewer', label: 'Viewer', level: 1 }],
      { kind: 'user', userId: 'u1', label: 'alice', level: 2 },
    );
    expect(out).toHaveLength(2);
  });

  it('replaces an existing draft with the same principal', () => {
    const existing: DraftDirectEntry[] = [
      { kind: 'user', userId: 'u1', label: 'alice', level: 1 },
    ];
    const out = upsertDraft(existing, {
      kind: 'user',
      userId: 'u1',
      label: 'alice',
      level: 4,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.level).toBe(4);
  });

  it('draftKey disambiguates kinds', () => {
    expect(draftKey({ kind: 'user', userId: 'u1', label: 'a', level: 1 })).toBe('user:u1');
    expect(draftKey({ kind: 'team', teamId: 'u1', label: 'a', level: 1 })).toBe('team:u1');
    expect(draftKey({ kind: 'role', role: 'Viewer', label: 'a', level: 1 })).toBe('role:Viewer');
  });
});

describe('levelLabel', () => {
  it('maps 1/2/4 to View/Edit/Admin', () => {
    expect(levelLabel(1)).toBe('View');
    expect(levelLabel(2)).toBe('Edit');
    expect(levelLabel(4)).toBe('Admin');
  });
});
