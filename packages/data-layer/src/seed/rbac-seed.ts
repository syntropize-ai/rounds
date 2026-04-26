/**
 * RBAC seed — populates the `role`, `permission`, and `builtin_role` tables
 * with the Grafana-parity built-in + fixed role catalog.
 *
 * Design refs:
 *  - docs/auth-perm-design/03-rbac-model.md (built-in role list, fixed roles)
 *  - docs/auth-perm-design/01-database-schema.md §role §permission §builtin_role
 *
 * Grafana reference (read for semantics only — NOT translated):
 *   pkg/services/accesscontrol/acimpl/service.go::declareFixedRoles
 *   pkg/services/accesscontrol/database/database.go
 *
 * Idempotency: every insert checks for an existing row (by uid or unique key).
 * Callers may invoke this on every app startup or on-demand from the admin API.
 * It never deletes rows — add-only — so operator-added custom permissions are
 * never clobbered.
 *
 * Per-org contract:
 *  - The four basic roles + Viewer/Editor/Admin builtin_role mappings are
 *    per-org. Server Admin is global (org_id='') and has ONE row regardless
 *    of how many orgs call seedRbacForOrg.
 *  - Fixed roles are global (org_id='') — they exist once across the whole
 *    install. Calling from multiple orgs is a no-op on subsequent calls.
 */

import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../db/sqlite-client.js';
import {
  BASIC_ROLE_DEFINITIONS,
  FIXED_ROLE_DEFINITIONS,
  resolveBasicRolePermissions,
  parseScope,
  type BasicRoleDefinition,
  type BuiltinPermission,
  type FixedPermission,
} from '@agentic-obs/common';
import { RoleRepository } from '../repository/auth/role-repository.js';
import { PermissionRepository } from '../repository/auth/permission-repository.js';
import { nowIso, uid } from '../repository/auth/shared.js';

export interface SeedRbacResult {
  /** Number of newly inserted role rows (basic + fixed). */
  rolesInserted: number;
  /** Number of newly inserted permission rows. */
  permissionsInserted: number;
  /** Number of newly inserted builtin_role mapping rows. */
  builtinMappingsInserted: number;
}

/**
 * Seed RBAC data for `orgId`. Also seeds global rows (fixed roles +
 * basic:server_admin + its builtin_role row) on the first call.
 *
 * Safe to call repeatedly — already-present rows are skipped.
 */
export async function seedRbacForOrg(
  db: SqliteClient,
  orgId: string,
): Promise<SeedRbacResult> {
  if (orgId === '') {
    throw new Error('seedRbacForOrg: orgId must be non-empty (use a real org id)');
  }

  const roleRepo = new RoleRepository(db);
  const permRepo = new PermissionRepository(db);

  const result: SeedRbacResult = {
    rolesInserted: 0,
    permissionsInserted: 0,
    builtinMappingsInserted: 0,
  };

  // -- 1. Seed global fixed roles (runs once regardless of which org asked). --
  for (const def of FIXED_ROLE_DEFINITIONS) {
    const existing = await roleRepo.findByUid('', def.uid);
    let roleId: string;
    if (existing) {
      roleId = existing.id;
    } else {
      const row = await roleRepo.create({
        orgId: '',
        name: def.name,
        uid: def.uid,
        displayName: def.displayName,
        description: def.description,
        groupName: def.groupName,
        hidden: def.hidden ?? false,
      });
      roleId = row.id;
      result.rolesInserted++;
    }
    result.permissionsInserted += await syncPermissions(
      db,
      permRepo,
      roleId,
      def.permissions,
    );
  }

  // -- 2. Seed the global basic:server_admin role + its builtin_role mapping.
  const serverAdminDef = findBasic('basic:server_admin');
  {
    const existing = await roleRepo.findByUid('', serverAdminDef.uid);
    let roleId: string;
    if (existing) {
      roleId = existing.id;
    } else {
      const row = await roleRepo.create({
        orgId: '',
        name: serverAdminDef.name,
        uid: serverAdminDef.uid,
        displayName: serverAdminDef.displayName,
        description: serverAdminDef.description,
        groupName: 'Basic',
      });
      roleId = row.id;
      result.rolesInserted++;
    }
    result.permissionsInserted += await syncPermissions(
      db,
      permRepo,
      roleId,
      resolveBasicRolePermissions(serverAdminDef.name),
    );
    // Server Admin maps globally — orgId '' regardless of which org is being
    // seeded. The upsert handles the "already linked" case.
    const before = await roleRepo.findBuiltinRole('Server Admin', '', roleId);
    await roleRepo.upsertBuiltinRole({
      role: 'Server Admin',
      roleId,
      orgId: '',
    });
    if (!before) result.builtinMappingsInserted++;
  }

  // -- 3. Seed per-org basic roles: Viewer / Editor / Admin ------------------
  for (const def of BASIC_ROLE_DEFINITIONS) {
    if (def.global) continue;
    const existing = await roleRepo.findByUid(orgId, def.uid);
    let roleId: string;
    if (existing) {
      roleId = existing.id;
    } else {
      const row = await roleRepo.create({
        orgId,
        name: def.name,
        uid: def.uid,
        displayName: def.displayName,
        description: def.description,
        groupName: 'Basic',
      });
      roleId = row.id;
      result.rolesInserted++;
    }
    result.permissionsInserted += await syncPermissions(
      db,
      permRepo,
      roleId,
      resolveBasicRolePermissions(def.name),
    );
    const before = await roleRepo.findBuiltinRole(
      def.builtinMappingRole,
      orgId,
      roleId,
    );
    await roleRepo.upsertBuiltinRole({
      role: def.builtinMappingRole,
      roleId,
      orgId,
    });
    if (!before) result.builtinMappingsInserted++;
  }

  return result;
}

// -- helpers --------------------------------------------------------------

function findBasic(name: BasicRoleDefinition['name']): BasicRoleDefinition {
  const d = BASIC_ROLE_DEFINITIONS.find((x) => x.name === name);
  if (!d) throw new Error(`[rbac-seed] missing basic role definition: ${name}`);
  return d;
}

/**
 * Ensure the permission set for `roleId` matches `desired`. Missing rows are
 * inserted; extra rows (from a previous shape) are left alone — a true "sync"
 * would delete stale ones, but that could trample operator customizations on
 * basic roles. Grafana's declareFixedRoles works the same way.
 *
 * Returns the count of rows inserted.
 */
async function syncPermissions(
  db: SqliteClient,
  permRepo: PermissionRepository,
  roleId: string,
  desired: readonly (BuiltinPermission | FixedPermission)[],
): Promise<number> {
  const existing = await permRepo.listByRole(roleId);
  const have = new Set(existing.map((p) => `${p.action}|${p.scope}`));
  let inserted = 0;
  const now = nowIso();
  for (const p of desired) {
    const key = `${p.action}|${p.scope}`;
    if (have.has(key)) continue;
    const parsed = parseScope(p.scope);
    db.run(sql`
      INSERT INTO permission (
        id, role_id, action, scope, kind, attribute, identifier, created, updated
      ) VALUES (
        ${uid()}, ${roleId}, ${p.action}, ${p.scope},
        ${parsed.kind}, ${parsed.attribute}, ${parsed.identifier},
        ${now}, ${now}
      )
    `);
    inserted++;
  }
  return inserted;
}
