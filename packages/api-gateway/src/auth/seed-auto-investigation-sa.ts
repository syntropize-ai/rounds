/**
 * Seed the `openobs` auto-investigation service account on first boot.
 *
 * Phase 8 / O1 of the auto-remediation design. The dispatcher
 * (#108 / alerts-boot.ts) needs an SA token to spawn background
 * investigations; this seed makes sure the SA user exists, ready for
 * an admin to mint a key for it via the existing service-account UI.
 *
 * Idempotent: if a user with login `openobs` and `is_service_account=1`
 * already exists, no-op. Org membership is also idempotent.
 *
 * Why we don't auto-mint the API key here: API keys are minted through
 * `ApiKeyService` which performs an audit + binds the key to the
 * caller's identity. Auto-minting at boot bypasses that and produces
 * unattributed audit rows. The setup story is:
 *   1. This seed creates the SA user.
 *   2. An admin opens the service-accounts page, picks `openobs`, and
 *      generates a token via the existing UI. The audit row attributes
 *      the key to that admin.
 *   3. Operator copies the raw `openobs_sa_...` token into the
 *      `AUTO_INVESTIGATION_SA_TOKEN` env var and restarts the gateway.
 */

import type {
  IOrgUserRepository,
  IUserRepository,
} from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';
import type { RoleService } from '../services/role-service.js';

/**
 * Fixed role uid that bundles OpsConnectorsRead + OpsCommandsRun on
 * `ops.connectors:*`. The role's `name` is `fixed:ops.commands:runner`;
 * `RoleService.assignRoleToUser` looks roles up by `uid`, which is the
 * `:`/`.`-replaced form (see fixed-roles-def.ts `def()`).
 */
const OPS_COMMANDS_RUNNER_ROLE_UID = 'fixed_ops_commands_runner';

const log = createLogger('seed-auto-investigation-sa');

export const AUTO_INVESTIGATION_SA_LOGIN = 'openobs';
export const AUTO_INVESTIGATION_SA_NAME = 'OpenObs Auto-Investigation';
/** SA users always live under a synthetic email; matches serviceaccount-service.ts's convention. */
export const AUTO_INVESTIGATION_SA_EMAIL = `${AUTO_INVESTIGATION_SA_LOGIN}@serviceaccount.local`;

export interface SeedAutoInvestigationSaDeps {
  users: IUserRepository;
  orgUsers: IOrgUserRepository;
  /**
   * Optional role service used to assign the `fixed:ops.commands:runner`
   * role to the SA so the ReAct loop's `ops_run_command` (kubectl) path is
   * permitted. When omitted, the fixed-role assignment is skipped — useful
   * for tests that don't care about RBAC wiring.
   */
  roles?: RoleService;
}

export interface SeedAutoInvestigationSaOptions {
  orgId?: string;
}

/**
 * Idempotently ensure the auto-investigation SA exists. Returns the
 * SA user id (existing or newly created), or `null` if seeding is
 * skipped (e.g. the org doesn't exist yet — caller should run after
 * org bootstrap).
 *
 * The SA is given org-role `Editor`. The agent's tool surface doesn't
 * include any plan-approval call site, so even though Editor's role
 * matrix grants `plans:approve`, there's no path for the SA to use it.
 * `plans:auto_edit` is NOT granted by Editor (per #99), so the SA
 * cannot approve plans in auto-edit mode either.
 *
 * Editor does NOT grant `ACTIONS.OpsCommandsRun`, so the ReAct loop's
 * `ops_run_command` (kubectl get/describe) path is denied by the
 * permission gate in agent-core/tool-permissions.ts. To unblock that
 * path the SA is additionally assigned the fixed role
 * `fixed:ops.commands:runner` (defined in
 * packages/common/src/rbac/fixed-roles-def.ts as OPS_COMMANDS_RUNNER),
 * which bundles `ops.connectors:read` + `ops.commands:run` on
 * `ops.connectors:*`. The assignment is idempotent and runs every boot
 * regardless of whether the SA user already exists, so existing
 * installs upgrade automatically.
 */
export async function seedAutoInvestigationSaIfNeeded(
  deps: SeedAutoInvestigationSaDeps,
  opts: SeedAutoInvestigationSaOptions = {},
): Promise<string | null> {
  const orgId = opts.orgId ?? 'org_main';

  const existing = await deps.users.findByLogin(AUTO_INVESTIGATION_SA_LOGIN);
  let userId: string;
  if (existing) {
    if (!existing.isServiceAccount) {
      log.warn(
        { userId: existing.id },
        'a regular user with login=openobs already exists; refusing to overwrite. ' +
        'Rename or delete that user, or set the auto-investigation SA up under a different login.',
      );
      return null;
    }
    // Ensure org membership is in place even if the row was created
    // out-of-band (e.g. by a previous seed run that didn't finish).
    const member = await deps.orgUsers.findMembership(orgId, existing.id);
    if (!member) {
      await deps.orgUsers.create({ orgId, userId: existing.id, role: 'Editor' });
      log.info({ userId: existing.id, orgId }, 'auto-investigation SA org membership repaired');
    }
    userId = existing.id;
  } else {
    const user = await deps.users.create({
      email: AUTO_INVESTIGATION_SA_EMAIL,
      name: AUTO_INVESTIGATION_SA_NAME,
      login: AUTO_INVESTIGATION_SA_LOGIN,
      orgId,
      isAdmin: false,
      isDisabled: false,
      isServiceAccount: true,
      emailVerified: false,
    });
    await deps.orgUsers.create({ orgId, userId: user.id, role: 'Editor' });
    log.info({ userId: user.id, login: user.login }, 'auto-investigation SA seeded');
    userId = user.id;
  }

  // Always (re)attempt the fixed-role assignment so existing installs
  // upgrade on the next boot. `assignRoleToUser` is idempotent: it
  // skips the insert when the role is already assigned.
  if (deps.roles) {
    try {
      await deps.roles.assignRoleToUser(orgId, userId, OPS_COMMANDS_RUNNER_ROLE_UID);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : err, userId, orgId, roleUid: OPS_COMMANDS_RUNNER_ROLE_UID },
        'failed to assign ops-commands-runner fixed role to auto-investigation SA; ' +
        'kubectl/ops_run_command will be denied for auto-investigations until this is fixed',
      );
    }
  }

  return userId;
}
