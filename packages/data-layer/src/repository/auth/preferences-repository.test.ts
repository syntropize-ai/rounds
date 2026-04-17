import { describe, it, expect, beforeEach } from 'vitest';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { PreferencesRepository } from './preferences-repository.js';
import { UserRepository } from './user-repository.js';
import { TeamRepository } from './team-repository.js';

describe('PreferencesRepository', () => {
  let db: SqliteClient;
  let repo: PreferencesRepository;
  // Preferences has FKs to user.id and team.id — we pre-seed one of each so
  // scope-specific tests have a valid principal.
  let userId: string;
  let teamId: string;

  beforeEach(async () => {
    db = createTestDb();
    repo = new PreferencesRepository(db);
    const userRepo = new UserRepository(db);
    const teamRepo = new TeamRepository(db);
    const u = await userRepo.create({
      email: 'p@x.test', name: 'P', login: 'pref_user', orgId: 'org_main',
    });
    userId = u.id;
    const t = await teamRepo.create({ orgId: 'org_main', name: 'pref-team' });
    teamId = t.id;
  });

  it('upsert() creates a new row for (org, null, null)', async () => {
    const p = await repo.upsert({ orgId: 'org_main', theme: 'dark' });
    expect(p.theme).toBe('dark');
    expect(p.userId).toBeNull();
    expect(p.teamId).toBeNull();
  });

  it('upsert() updates the existing row on second call', async () => {
    await repo.upsert({ orgId: 'org_main', theme: 'dark' });
    const updated = await repo.upsert({ orgId: 'org_main', theme: 'light' });
    expect(updated.theme).toBe('light');
    expect(updated.version).toBe(1);
  });

  it('upsert() creates separate rows for org/user/team scopes', async () => {
    await repo.upsert({ orgId: 'org_main', theme: 'dark' });
    await repo.upsert({ orgId: 'org_main', userId, theme: 'light' });
    await repo.upsert({ orgId: 'org_main', teamId, theme: 'dark' });
    const org = await repo.findOrgPrefs('org_main');
    const user = await repo.findUserPrefs('org_main', userId);
    const team = await repo.findTeamPrefs('org_main', teamId);
    expect(org!.theme).toBe('dark');
    expect(user!.theme).toBe('light');
    expect(team!.theme).toBe('dark');
  });

  it('findUserPrefs() returns null when missing', async () => {
    expect(await repo.findUserPrefs('org_main', 'missing')).toBeNull();
  });

  it('update() mutates a single pref and bumps version', async () => {
    const p = await repo.upsert({ orgId: 'org_main', theme: 'dark' });
    const updated = await repo.update(p.id, { theme: 'light', timezone: 'UTC' });
    expect(updated!.theme).toBe('light');
    expect(updated!.timezone).toBe('UTC');
    expect(updated!.version).toBe(1);
  });

  it('update() returns null for unknown id', async () => {
    expect(await repo.update('missing', { theme: 'dark' })).toBeNull();
  });

  it('delete() removes the row', async () => {
    const p = await repo.upsert({ orgId: 'org_main', theme: 'dark' });
    expect(await repo.delete(p.id)).toBe(true);
    expect(await repo.findOrgPrefs('org_main')).toBeNull();
  });

  it('unique (org, user, team) via COALESCE enforces one row per scope', async () => {
    await repo.upsert({ orgId: 'org_main', userId, theme: 'dark' });
    // Second upsert for the same (org, user, null) should update rather than duplicate.
    const p2 = await repo.upsert({ orgId: 'org_main', userId, theme: 'light' });
    expect(p2.theme).toBe('light');
    const user = await repo.findUserPrefs('org_main', userId);
    expect(user!.id).toBe(p2.id);
  });

  it('homeDashboardUid is round-tripped', async () => {
    const p = await repo.upsert({ orgId: 'org_main', homeDashboardUid: 'dash_home' });
    expect(p.homeDashboardUid).toBe('dash_home');
  });

  it('jsonData stores arbitrary text payload', async () => {
    const p = await repo.upsert({
      orgId: 'org_main', jsonData: JSON.stringify({ foo: 1 }),
    });
    expect(p.jsonData).toBe('{"foo":1}');
  });
});
