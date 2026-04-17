# 05 — Teams

**Applies to:** T5.1–T5.3
**Grafana reference:**
- `pkg/services/team/` — service + model
- `pkg/services/team/teamimpl/` — implementation
- `pkg/api/team.go` — HTTP handlers
- `pkg/services/login/authinfoimpl/` — external sync hooks
- `pkg/services/ldap/ldapimpl/ldap.go::syncTeamMembers`

## Concept

A **team** is a named group of users within an org. Teams are principals for permission grants:

- RBAC: roles can be assigned to teams via `team_role`.
- Legacy ACL: `dashboard_acl` rows can reference a team.

Users inherit the union of their teams' permissions. Teams themselves don't have roles — permissions attach per team.

## Entities

```ts
interface Team {
  id: string
  orgId: string
  name: string
  email?: string
  external: boolean     // true if synced from IdP
  memberCount?: number  // denormalized on list responses
  created: number
  updated: number
}

interface TeamMember {
  id: string
  orgId: string
  teamId: string
  userId: string
  external: boolean
  permission: TeamPermission  // Member=0 | Admin=4
  created: number
  updated: number
}

export const TeamPermission = {
  Member: 0,
  Admin:  4,
} as const
```

`TeamPermission.Admin` only means "can edit this team's membership" — it does not grant any broader permission.

## CRUD service

File: `packages/api-gateway/src/services/team-service.ts`.

```ts
interface ITeamService {
  create(orgId: string, input: { name: string; email?: string; external?: boolean }): Promise<Team>
  getById(orgId: string, id: string): Promise<Team | null>
  list(orgId: string, opts?: { query?: string; limit?: number; offset?: number; userId?: string }): Promise<{ items: Team[]; total: number }>
  update(orgId: string, id: string, patch: Partial<Team>): Promise<Team>
  delete(orgId: string, id: string): Promise<void>

  // Membership
  addMember(orgId: string, teamId: string, userId: string, permission?: TeamPermission): Promise<TeamMember>
  updateMember(orgId: string, teamId: string, userId: string, permission: TeamPermission): Promise<TeamMember>
  removeMember(orgId: string, teamId: string, userId: string): Promise<void>
  listMembers(orgId: string, teamId: string): Promise<TeamMember[]>
  listTeamsForUser(orgId: string, userId: string): Promise<Team[]>
}
```

### Invariants

- A user can be in multiple teams within an org.
- External teams (`team.external=1`) can only be mutated via sync; direct `addMember`/`removeMember` returns 400 unless the member is also external.
- `team.name` unique within org (enforced by `ux_team_org_name`).
- Deleting a team cascade-deletes `team_member`, `team_role`, and any `dashboard_acl` rows referencing it.

## HTTP API

See [08-api-surface.md](08-api-surface.md) §teams. Summary:

- `GET    /api/teams/search?query=&perpage=&page=` — list in current org
- `POST   /api/teams` — create (requires `teams:create`)
- `GET    /api/teams/:id`
- `PUT    /api/teams/:id` — update
- `DELETE /api/teams/:id`
- `GET    /api/teams/:id/members`
- `POST   /api/teams/:id/members` — body: `{ userId }`
- `PUT    /api/teams/:id/members/:userId` — update permission (Member/Admin)
- `DELETE /api/teams/:id/members/:userId`
- `GET    /api/teams/:id/preferences`
- `PUT    /api/teams/:id/preferences`

Mirror `pkg/api/team.go` routes.

## Permission resolution (T5.3)

When computing a user's permissions for access-control evaluation:

```
user_permissions = user.directly_assigned_roles ∪
                    user.org_role.permissions ∪
                    (for each team the user is in in current org:
                       team.assigned_roles.permissions)
```

Implementation: `accessControlService.getUserPermissions(userId, orgId)`:

```ts
const teams = await teamRepo.listTeamsForUser(orgId, userId)
const teamIds = teams.map(t => t.id)
const perms = await db.query(`
  SELECT p.action, p.scope
  FROM permission p
  WHERE p.role_id IN (
    SELECT role_id FROM user_role WHERE user_id = ? AND (org_id = '' OR org_id = ?)
    UNION
    SELECT role_id FROM team_role WHERE team_id IN (${placeholders(teamIds)}) AND (org_id = '' OR org_id = ?)
    UNION
    SELECT role_id FROM builtin_role WHERE role = ? AND (org_id = '' OR org_id = ?)
  )
`, [userId, orgId, ...teamIds, orgId, user.orgRole, orgId])
```

(Pseudo-SQL; actual query built via parameterized query builder. See Grafana's `pkg/services/accesscontrol/database/database.go::GetUserPermissions` for exact shape including legacy ACL merge.)

Cache per-request (attach to `req.auth`).

Invalidation: on any change to team membership, role assignment, or org role — caller doesn't need to do anything; cache is per-request only, so next request recomputes.

## External sync (T5.2)

Optional. If an auth provider (OAuth, SAML, LDAP) supplies group memberships, sync:

```ts
interface TeamSyncInput {
  userId: string
  orgId: string
  externalGroups: string[]    // names or DNs
  authModule: string
}

async function syncTeams(input: TeamSyncInput): Promise<void>
```

Algorithm:

1. Resolve each `externalGroup` to an internal team:
   - Exact name match: `team WHERE org_id=? AND name=? AND external=1`.
   - No match → skip (we don't auto-create teams from unknown groups; admin must pre-create).
2. Compute delta:
   - `desired = mapped_team_ids`
   - `current_external = team_member WHERE user_id=? AND org_id=? AND external=1`
   - To add: `desired - current_external`
   - To remove: `current_external - desired`
3. Apply: `addMember(...external=true)` and `removeMember(...)` atomically in a transaction.
4. Non-external memberships (manually added) are never touched.

Group mapping configuration is per-provider:
- OAuth: `oauth.github.team_ids` (env-like `[ { group: "infra", team_id: "team-infra" } ]`). Match Grafana's `AllowedGroups` config concept.
- SAML: attribute mapping, `team_ids` extension in config.
- LDAP: `[[servers.group_mappings]]` in `ldap.toml`.

## Frontend

See [09-frontend.md](09-frontend.md) §teams-tab.

- Admin page Teams tab lists teams in current org with search.
- Team detail drawer: members list, role assignments, preferences.
- Add-member picker: searches users (within org) via `/api/org/users?query=`.

## Test scenarios (MUST be implemented)

1. Create team in org → row exists, creator is not auto-added as member (Grafana doesn't auto-add).
2. List teams filtered by `userId` → only teams that user belongs to.
3. Add member → team_member row.
4. Change member permission Member → Admin.
5. Remove member.
6. Delete team → team_member, team_role rows gone; dashboard_acl rows referencing team gone.
7. Assign role to team → user in team gets role's permissions.
8. User in two teams with different roles → union of permissions.
9. External team rejects manual add.
10. External sync: user enters with groups [A, B] → team_members for A, B (external=1). Next login with [B, C] → A removed, B kept, C added. Manually added team M unchanged.
11. Team name unique per org.
12. Two orgs can each have a team named "SRE" independently.
13. Team member cascade: delete user → team_member rows deleted; delete team → team_member rows deleted; delete org → everything under cascade.

## File scope for T5 agents

- `packages/common/src/models/team.ts`
- `packages/api-gateway/src/services/team-service.ts`
- `packages/api-gateway/src/routes/teams.ts`
- `packages/data-layer/src/repositories/team-repository.ts`
- `packages/data-layer/src/repositories/team-member-repository.ts`
- `packages/api-gateway/src/auth/team-sync.ts` — T5.2 new
- Touch `accesscontrol-service.ts` for T5.3 to include team-role permissions in resolution
