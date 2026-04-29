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

const log = createLogger('seed-auto-investigation-sa');

export const AUTO_INVESTIGATION_SA_LOGIN = 'openobs';
export const AUTO_INVESTIGATION_SA_NAME = 'OpenObs Auto-Investigation';
/** SA users always live under a synthetic email; matches serviceaccount-service.ts's convention. */
export const AUTO_INVESTIGATION_SA_EMAIL = `${AUTO_INVESTIGATION_SA_LOGIN}@serviceaccount.local`;

export interface SeedAutoInvestigationSaDeps {
  users: IUserRepository;
  orgUsers: IOrgUserRepository;
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
 */
export async function seedAutoInvestigationSaIfNeeded(
  deps: SeedAutoInvestigationSaDeps,
  opts: SeedAutoInvestigationSaOptions = {},
): Promise<string | null> {
  const orgId = opts.orgId ?? 'org_main';

  const existing = await deps.users.findByLogin(AUTO_INVESTIGATION_SA_LOGIN);
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
    return existing.id;
  }

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
  return user.id;
}
