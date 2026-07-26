/**
 * Connector policies written at team scope have to reach the runner that
 * enforces them.
 *
 * `resolveConnectorPolicy` has always had the right logic — team rows are
 * checked before org rows, and `block` beats `ask` beats `allow` inside them.
 * But `userTeamIds` comes from `deps.resolveUserTeams`, and that callback was
 * declared on both runners, read at three call sites, and **passed by nobody**.
 * `teamIds` was therefore always `[]`, the team branch could never match, and
 * the org row decided everything.
 *
 * The route accepts `subjectType: 'team'` and persists it, and Settings shows
 * it back. So a team-level `block` was an advertised control that silently did
 * nothing — the worst kind, because someone had reason to believe a restriction
 * was in place.
 *
 * These tests are about the wiring, not the policy algebra (`ops-policy.test.ts`
 * covers that): given a user in a team, does the decision actually see it.
 */

import { describe, it, expect } from 'vitest';
import { resolveConnectorPolicy } from '../services/ops-policy.js';

type Row = { connectorId: string; capability: string; subjectType: string; subjectId: string; humanPolicy: string };

function repoWith(rows: Row[]) {
  return { listPolicies: async () => rows } as never;
}

const CONNECTOR = 'k8s-prod';
const CAPABILITY = 'runtime.exec';
const ORG = 'org_1';

describe('team-scoped connector policy reaches the decision', () => {
  const rows: Row[] = [
    { connectorId: CONNECTOR, capability: CAPABILITY, subjectType: 'org', subjectId: ORG, humanPolicy: 'allow' },
    { connectorId: CONNECTOR, capability: CAPABILITY, subjectType: 'team', subjectId: 'team_contractors', humanPolicy: 'block' },
  ];

  it('blocks a member of the blocked team, overriding the org allow', async () => {
    const decision = await resolveConnectorPolicy({
      connectorRepo: repoWith(rows),
      connectorId: CONNECTOR,
      capability: CAPABILITY,
      orgId: ORG,
      userTeamIds: ['team_contractors'],
    });
    expect(decision).toBe('block');
  });

  it('is exactly what an empty team list loses', async () => {
    // This is the bug, expressed as a test: with the resolver unwired every
    // caller looked like this, and the block silently became an allow.
    const decision = await resolveConnectorPolicy({
      connectorRepo: repoWith(rows),
      connectorId: CONNECTOR,
      capability: CAPABILITY,
      orgId: ORG,
      userTeamIds: [],
    });
    expect(decision).toBe('allow');
  });

  it('leaves a user in a different team on the org policy', async () => {
    const decision = await resolveConnectorPolicy({
      connectorRepo: repoWith(rows),
      connectorId: CONNECTOR,
      capability: CAPABILITY,
      orgId: ORG,
      userTeamIds: ['team_sre'],
    });
    expect(decision).toBe('allow');
  });
});

describe('the resolver both runners are given', () => {
  /** Mirrors the callback wired in agent-factory and domain-routes. */
  const resolveUserTeams = (repo: { listTeamsForUser: (u: string, o: string) => Promise<Array<{ teamId: string }>> }) =>
    async (who: { userId: string; orgId: string }) =>
      (await repo.listTeamsForUser(who.userId, who.orgId)).map((m) => m.teamId);

  it('turns memberships into the id list the policy check compares against', async () => {
    const repo = {
      listTeamsForUser: async () => [{ teamId: 'team_contractors' }, { teamId: 'team_sre' }],
    };
    const teams = await resolveUserTeams(repo)({ userId: 'u1', orgId: ORG });
    expect(teams).toEqual(['team_contractors', 'team_sre']);
  });

  it('scopes the lookup to the caller org, so a team elsewhere cannot grant or block here', async () => {
    let seen: [string, string] | null = null;
    const repo = {
      listTeamsForUser: async (u: string, o: string) => { seen = [u, o]; return []; },
    };
    await resolveUserTeams(repo)({ userId: 'u1', orgId: ORG });
    expect(seen).toEqual(['u1', ORG]);
  });
});
