/**
 * Grafana ref: pkg/services/team/model.go::Team
 * See docs/auth-perm-design/01-database-schema.md §team
 */
export interface Team {
  id: string;
  orgId: string;
  name: string;
  email: string | null;
  /** 1 if synced from LDAP/OIDC group. */
  external: boolean;
  created: string;
  updated: string;
}

export interface NewTeam {
  id?: string;
  orgId: string;
  name: string;
  email?: string | null;
  external?: boolean;
}

export interface TeamPatch {
  name?: string;
  email?: string | null;
  external?: boolean;
}

/**
 * Grafana encodes team member rank as an int — 0=Member, 4=Admin.
 * Preserve the encoding (see 01-database-schema.md §team_member).
 */
export const TEAM_MEMBER_PERMISSION_MEMBER = 0;
export const TEAM_MEMBER_PERMISSION_ADMIN = 4;
export type TeamMemberPermission =
  | typeof TEAM_MEMBER_PERMISSION_MEMBER
  | typeof TEAM_MEMBER_PERMISSION_ADMIN;

export interface TeamMember {
  id: string;
  orgId: string;
  teamId: string;
  userId: string;
  external: boolean;
  permission: TeamMemberPermission;
  created: string;
  updated: string;
}

export interface NewTeamMember {
  id?: string;
  orgId: string;
  teamId: string;
  userId: string;
  external?: boolean;
  permission?: TeamMemberPermission;
}
