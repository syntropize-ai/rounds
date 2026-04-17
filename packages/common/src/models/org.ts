/**
 * Grafana ref: pkg/services/org/model.go::Org
 * See docs/auth-perm-design/01-database-schema.md §org
 *
 * The openobs "workspace" concept is being renamed to Org in T4.5. Until then,
 * both exist; fresh installs use `org_main` seeded by migration 001.
 */
export interface Org {
  id: string;
  version: number;
  name: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
  billingEmail?: string;
  created: string;
  updated: string;
}

export interface NewOrg {
  id?: string;
  name: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
  billingEmail?: string;
}

export interface OrgPatch {
  name?: string;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  country?: string | null;
  billingEmail?: string | null;
}

/**
 * Org-scoped role assignment. Grafana RoleType, PascalCase-exact strings.
 * See pkg/models/roles.go.
 */
export type OrgRole = 'Admin' | 'Editor' | 'Viewer' | 'None';
export const ORG_ROLES: readonly OrgRole[] = ['Admin', 'Editor', 'Viewer', 'None'] as const;

export interface OrgUser {
  id: string;
  orgId: string;
  userId: string;
  role: OrgRole;
  created: string;
  updated: string;
}

export interface NewOrgUser {
  id?: string;
  orgId: string;
  userId: string;
  role: OrgRole;
}
