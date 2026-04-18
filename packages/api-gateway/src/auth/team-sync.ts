/**
 * Team sync — reconcile a user's external team memberships against the set of
 * groups/DNs an IdP reports for them.
 *
 * Called from auth providers (LDAP, OAuth, SAML) on each login. Opt-in per
 * provider via config flags:
 *   - LDAP_SYNC_TEAMS=true (default false)
 *   - OAUTH_<PROVIDER>_SYNC_TEAMS=true (default false)
 *
 * Algorithm — see docs/auth-perm-design/05-teams.md §external-sync:
 *   1. Resolve each external group name/DN to a team in the org where the team
 *      was pre-created with `external=1`. Names that don't match a team are
 *      skipped — we never auto-create teams.
 *   2. Compute delta against the user's existing external memberships:
 *        desired = mapped team ids
 *        current = team_member rows where user_id=?, org_id=?, external=1
 *      to_add    = desired - current
 *      to_remove = current - desired
 *   3. Apply via TeamService.addMember({ external: true }) /
 *      TeamService.removeMember({ external: true }). The service short-circuits
 *      removes that target `external=0` rows, which preserves manually-added
 *      memberships across sync cycles.
 *   4. Return the diff for audit / debug logging.
 *
 * Grafana reference (read for semantics only, nothing copied):
 *   pkg/services/ldap/ldapimpl/ldap.go::syncTeamMembers
 *   pkg/services/authn/clients/oauth.go::syncTeamMembership (Enterprise-only;
 *   structure only).
 */

import type {
  ITeamMemberRepository,
  ITeamRepository,
} from '@agentic-obs/common';
import type { TeamService } from '../services/team-service.js';

export type TeamSyncAuthModule =
  | 'ldap'
  | 'oauth_github'
  | 'oauth_google'
  | 'oauth_generic'
  | 'saml';

export interface TeamSyncInput {
  userId: string;
  orgId: string;
  /** Group names or DNs from the IdP — may be empty. */
  externalGroups: string[];
  authModule: TeamSyncAuthModule;
}

export interface TeamSyncDeps {
  teams: ITeamRepository;
  teamMembers: ITeamMemberRepository;
  teamService: TeamService;
}

export interface TeamSyncResult {
  /** Team ids the user was added to during this sync. */
  added: string[];
  /** Team ids the user was removed from during this sync. */
  removed: string[];
  /** Group names from input that couldn't be mapped to a team. */
  skipped: string[];
}

/**
 * Resolve group names/DNs to external teams within the org. Only matches teams
 * with `external=1` — we never promote a non-external team via sync. Returns
 * a tuple of (mapped team ids, skipped group names).
 */
async function resolveGroups(
  deps: TeamSyncDeps,
  orgId: string,
  externalGroups: string[],
): Promise<{ mapped: Set<string>; skipped: string[] }> {
  const mapped = new Set<string>();
  const skipped: string[] = [];
  for (const raw of externalGroups) {
    const name = (raw ?? '').trim();
    if (!name) continue;
    const team = await deps.teams.findByName(orgId, name);
    if (team && team.external) {
      mapped.add(team.id);
    } else {
      skipped.push(name);
    }
  }
  return { mapped, skipped };
}

export async function syncTeams(
  deps: TeamSyncDeps,
  input: TeamSyncInput,
): Promise<TeamSyncResult> {
  if (!input.userId || !input.orgId) {
    return { added: [], removed: [], skipped: [] };
  }

  const { mapped, skipped } = await resolveGroups(
    deps,
    input.orgId,
    input.externalGroups,
  );

  // Current external memberships within the org.
  const memberships = await deps.teamMembers.listTeamsForUser(
    input.userId,
    input.orgId,
  );
  const currentExternal = new Set(
    memberships.filter((m) => m.external).map((m) => m.teamId),
  );

  const added: string[] = [];
  const removed: string[] = [];

  for (const teamId of mapped) {
    if (currentExternal.has(teamId)) continue;
    try {
      await deps.teamService.addMember(input.orgId, teamId, input.userId, 0, {
        external: true,
      });
      added.push(teamId);
    } catch (err) {
      // If the membership was created by a concurrent sync since we read the
      // snapshot, treat it as a no-op. Any other error is surfaced.
      const message = err instanceof Error ? err.message : String(err);
      if (!/already a team member/i.test(message)) throw err;
    }
  }

  for (const teamId of currentExternal) {
    if (mapped.has(teamId)) continue;
    await deps.teamService.removeMember(
      input.orgId,
      teamId,
      input.userId,
      { external: true },
    );
    removed.push(teamId);
  }

  return { added, removed, skipped };
}

// — Config helpers ————————————————————————————————————————————————

/**
 * Per-provider on/off flag. Matches Grafana's opt-in model where LDAP and
 * OAuth sync team memberships only when the operator enables it in config.
 */
export function teamSyncEnabledFor(
  authModule: TeamSyncAuthModule,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  switch (authModule) {
    case 'ldap':
      return env['LDAP_SYNC_TEAMS'] === 'true';
    case 'oauth_github':
      return env['OAUTH_GITHUB_SYNC_TEAMS'] === 'true';
    case 'oauth_google':
      return env['OAUTH_GOOGLE_SYNC_TEAMS'] === 'true';
    case 'oauth_generic':
      return env['OAUTH_GENERIC_SYNC_TEAMS'] === 'true';
    case 'saml':
      return env['SAML_SYNC_TEAMS'] === 'true';
    default:
      return false;
  }
}
