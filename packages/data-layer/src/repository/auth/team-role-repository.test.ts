import { describe, it, expect, beforeEach } from 'vitest';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { TeamRoleRepository } from './team-role-repository.js';
import { TeamRepository } from './team-repository.js';
import { RoleRepository } from './role-repository.js';

describe('TeamRoleRepository', () => {
  let db: SqliteClient;
  let repo: TeamRoleRepository;
  let teamId: string;
  let roleId: string;

  beforeEach(async () => {
    db = createTestDb();
    repo = new TeamRoleRepository(db);
    const teamRepo = new TeamRepository(db);
    const roleRepo = new RoleRepository(db);
    const t = await teamRepo.create({ orgId: 'org_main', name: 'tr-team' });
    const r = await roleRepo.create({ orgId: 'org_main', name: 'fixed:tr', uid: 'fixed_tr' });
    teamId = t.id;
    roleId = r.id;
  });

  it('create() inserts a team role row', async () => {
    const tr = await repo.create({ orgId: 'org_main', teamId, roleId });
    expect(tr.teamId).toBe(teamId);
  });

  it('findById() returns the row', async () => {
    const tr = await repo.create({ orgId: 'org_main', teamId, roleId });
    expect((await repo.findById(tr.id))!.id).toBe(tr.id);
  });

  it('listByTeam() returns assignments', async () => {
    await repo.create({ orgId: 'org_main', teamId, roleId });
    expect(await repo.listByTeam(teamId)).toHaveLength(1);
  });

  it('listByTeams() fetches for multiple teams', async () => {
    const teamRepo = new TeamRepository(db);
    const t2 = await teamRepo.create({ orgId: 'org_main', name: 'tr-team-2' });
    await repo.create({ orgId: 'org_main', teamId, roleId });
    await repo.create({ orgId: 'org_main', teamId: t2.id, roleId });
    expect(await repo.listByTeams([teamId, t2.id])).toHaveLength(2);
  });

  it('listByTeam() with org filter includes global roles', async () => {
    const roleRepo = new RoleRepository(db);
    const g = await roleRepo.create({ orgId: '', name: 'global', uid: 'global_u' });
    await repo.create({ orgId: 'org_main', teamId, roleId });
    await repo.create({ orgId: '', teamId, roleId: g.id });
    expect(await repo.listByTeam(teamId, 'org_main')).toHaveLength(2);
  });

  it('listByRole() returns assignments for a role', async () => {
    await repo.create({ orgId: 'org_main', teamId, roleId });
    expect(await repo.listByRole(roleId)).toHaveLength(1);
  });

  it('remove() deletes by (org, team, role)', async () => {
    await repo.create({ orgId: 'org_main', teamId, roleId });
    expect(await repo.remove('org_main', teamId, roleId)).toBe(true);
  });

  it('unique (org, team, role) rejects duplicates', async () => {
    await repo.create({ orgId: 'org_main', teamId, roleId });
    await expect(
      repo.create({ orgId: 'org_main', teamId, roleId }),
    ).rejects.toThrow();
  });

  it('delete() removes a single row', async () => {
    const tr = await repo.create({ orgId: 'org_main', teamId, roleId });
    expect(await repo.delete(tr.id)).toBe(true);
  });

  it('cascade deletes assignments when team is deleted', async () => {
    await repo.create({ orgId: 'org_main', teamId, roleId });
    const teamRepo = new TeamRepository(db);
    await teamRepo.delete(teamId);
    expect(await repo.listByTeam(teamId)).toHaveLength(0);
  });
});
