/**
 * Resolver cascade tests (T7.3).
 *
 * Verifies:
 *   - folders resolver expands uid to every ancestor uid
 *   - dashboards resolver, given a dashboardFolderUid lookup, walks the
 *     folder chain and emits folders:uid:<ancestor> scopes
 *   - alert.rules resolver does the same via alertRuleFolderUid
 *   - resolvers survive lookup failures by returning at least the literal
 *     scope plus wildcards
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTestDb,
  seedDefaultOrg,
  FolderRepository,
} from '@agentic-obs/data-layer';
import type { SqliteClient } from '@agentic-obs/data-layer';
import { createResolverRegistry } from './index.js';

describe('resolver cascade', () => {
  let db: SqliteClient;
  beforeEach(async () => {
    db = createTestDb();
    await seedDefaultOrg(db);
  });

  it('folders resolver emits ancestor scopes', async () => {
    const folders = new FolderRepository(db);
    const a = await folders.create({
      orgId: 'org_main',
      uid: 'a',
      title: 'A',
    });
    const b = await folders.create({
      orgId: 'org_main',
      uid: 'b',
      title: 'B',
      parentUid: a.uid,
    });
    const c = await folders.create({
      orgId: 'org_main',
      uid: 'c',
      title: 'C',
      parentUid: b.uid,
    });
    void c;
    const reg = createResolverRegistry({
      orgId: 'org_main',
      folders,
    });
    const out = await reg.resolve('folders:uid:c');
    expect(out).toContain('folders:uid:c');
    expect(out).toContain('folders:uid:b');
    expect(out).toContain('folders:uid:a');
    expect(out).toContain('folders:*');
  });

  it('dashboards resolver emits folder cascade when dashboardFolderUid is wired', async () => {
    const folders = new FolderRepository(db);
    const root = await folders.create({
      orgId: 'org_main',
      uid: 'root',
      title: 'Root',
    });
    const sub = await folders.create({
      orgId: 'org_main',
      uid: 'sub',
      title: 'Sub',
      parentUid: root.uid,
    });
    const reg = createResolverRegistry({
      orgId: 'org_main',
      folders,
      dashboardFolderUid: async (_org, uid) =>
        uid === 'dash_x' ? sub.uid : null,
    });
    const out = await reg.resolve('dashboards:uid:dash_x');
    expect(out).toContain('dashboards:uid:dash_x');
    expect(out).toContain('folders:uid:sub');
    expect(out).toContain('folders:uid:root');
  });

  it('dashboards resolver without lookup still returns literal + wildcards', async () => {
    const folders = new FolderRepository(db);
    const reg = createResolverRegistry({ orgId: 'org_main', folders });
    const out = await reg.resolve('dashboards:uid:dash_y');
    expect(out).toContain('dashboards:uid:dash_y');
    expect(out).toContain('dashboards:*');
  });

  it('dashboards resolver with a failing lookup falls back to wildcards', async () => {
    const folders = new FolderRepository(db);
    const reg = createResolverRegistry({
      orgId: 'org_main',
      folders,
      dashboardFolderUid: async () => {
        throw new Error('db offline');
      },
    });
    const out = await reg.resolve('dashboards:uid:dash_z');
    expect(out).toContain('dashboards:uid:dash_z');
    expect(out).toContain('folders:*');
  });

  it('alert.rules resolver emits folder cascade when alertRuleFolderUid is wired', async () => {
    const folders = new FolderRepository(db);
    const f = await folders.create({
      orgId: 'org_main',
      uid: 'af',
      title: 'Alerts',
    });
    const reg = createResolverRegistry({
      orgId: 'org_main',
      folders,
      alertRuleFolderUid: async (_org, uid) =>
        uid === 'rule_1' ? f.uid : null,
    });
    const out = await reg.resolve('alert.rules:uid:rule_1');
    expect(out).toContain('alert.rules:uid:rule_1');
    expect(out).toContain(`folders:uid:${f.uid}`);
    expect(out).toContain('folders:*');
  });

  it('wildcard dashboards scope is returned unchanged except for wildcards', async () => {
    const folders = new FolderRepository(db);
    const reg = createResolverRegistry({ orgId: 'org_main', folders });
    const out = await reg.resolve('dashboards:uid:*');
    expect(out).toContain('dashboards:uid:*');
    expect(out).toContain('dashboards:*');
  });

  it('folders resolver with unknown uid still returns literal + wildcards', async () => {
    const folders = new FolderRepository(db);
    const reg = createResolverRegistry({ orgId: 'org_main', folders });
    const out = await reg.resolve('folders:uid:unknown_folder');
    expect(out).toContain('folders:uid:unknown_folder');
    expect(out).toContain('folders:*');
  });
});
