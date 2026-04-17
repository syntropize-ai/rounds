import { describe, it, expect, beforeEach } from 'vitest';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { TeamMemberRepository } from './team-member-repository.js';
import { TeamRepository } from './team-repository.js';
import { UserRepository } from './user-repository.js';
import {
  TEAM_MEMBER_PERMISSION_ADMIN,
  TEAM_MEMBER_PERMISSION_MEMBER,
} from '@agentic-obs/common';

describe('TeamMemberRepository', () => {
  let db: SqliteClient;
  let repo: TeamMemberRepository;
  let teamId: string;
  let userA: string;
  let userB: string;

  beforeEach(async () => {
    db = createTestDb();
    repo = new TeamMemberRepository(db);
    const teamRepo = new TeamRepository(db);
    const userRepo = new UserRepository(db);
    const t = await teamRepo.create({ orgId: 'org_main', name: 'tm-test' });
    teamId = t.id;
    userA = (
      await userRepo.create({ email: 'a@x.test', name: 'A', login: 'a_tm', orgId: 'org_main' })
    ).id;
    userB = (
      await userRepo.create({ email: 'b@x.test', name: 'B', login: 'b_tm', orgId: 'org_main' })
    ).id;
  });

  it('create() adds a member at default permission=0', async () => {
    const m = await repo.create({ orgId: 'org_main', teamId, userId: userA });
    expect(m.permission).toBe(TEAM_MEMBER_PERMISSION_MEMBER);
  });

  it('create() can add a team admin', async () => {
    const m = await repo.create({
      orgId: 'org_main', teamId, userId: userA, permission: TEAM_MEMBER_PERMISSION_ADMIN,
    });
    expect(m.permission).toBe(TEAM_MEMBER_PERMISSION_ADMIN);
  });

  it('findMembership() returns the row', async () => {
    await repo.create({ orgId: 'org_main', teamId, userId: userA });
    const found = await repo.findMembership(teamId, userA);
    expect(found!.userId).toBe(userA);
  });

  it('listByTeam() returns all members', async () => {
    await repo.create({ orgId: 'org_main', teamId, userId: userA });
    await repo.create({ orgId: 'org_main', teamId, userId: userB });
    expect(await repo.listByTeam(teamId)).toHaveLength(2);
  });

  it('listTeamsForUser() returns the user\'s teams', async () => {
    await repo.create({ orgId: 'org_main', teamId, userId: userA });
    const out = await repo.listTeamsForUser(userA);
    expect(out).toHaveLength(1);
    expect(out[0]!.teamId).toBe(teamId);
  });

  it('listTeamsForUser() can filter by org', async () => {
    await repo.create({ orgId: 'org_main', teamId, userId: userA });
    expect(await repo.listTeamsForUser(userA, 'other_org')).toHaveLength(0);
  });

  it('updatePermission() changes rank', async () => {
    await repo.create({ orgId: 'org_main', teamId, userId: userA });
    const updated = await repo.updatePermission(
      teamId, userA, TEAM_MEMBER_PERMISSION_ADMIN,
    );
    expect(updated!.permission).toBe(TEAM_MEMBER_PERMISSION_ADMIN);
  });

  it('remove() deletes the membership', async () => {
    await repo.create({ orgId: 'org_main', teamId, userId: userA });
    expect(await repo.remove(teamId, userA)).toBe(true);
    expect(await repo.findMembership(teamId, userA)).toBeNull();
  });

  it('removeAllByUser() handles multiple teams for the user', async () => {
    const teamRepo = new TeamRepository(db);
    const t2 = await teamRepo.create({ orgId: 'org_main', name: 'tm-test-2' });
    await repo.create({ orgId: 'org_main', teamId, userId: userA });
    await repo.create({ orgId: 'org_main', teamId: t2.id, userId: userA });
    expect(await repo.removeAllByUser(userA)).toBe(2);
  });

  it('unique (team, user) rejects duplicates', async () => {
    await repo.create({ orgId: 'org_main', teamId, userId: userA });
    await expect(
      repo.create({ orgId: 'org_main', teamId, userId: userA }),
    ).rejects.toThrow();
  });

  it('cascade deletes members when team is deleted', async () => {
    await repo.create({ orgId: 'org_main', teamId, userId: userA });
    const teamRepo = new TeamRepository(db);
    await teamRepo.delete(teamId);
    expect(await repo.findMembership(teamId, userA)).toBeNull();
  });
});
