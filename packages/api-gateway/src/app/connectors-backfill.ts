/**
 * @deprecated Phase A (ops-trust-model v4): the per-capability per-team
 * policy table this function seeded is no longer consulted by the ops
 * command runner. The function is retained as a no-op so the boot wiring
 * in `server.ts` keeps compiling; it will be removed when the policy
 * schema is dropped in a later phase.
 *
 * Calling this is harmless — it logs once and returns. We deliberately
 * do NOT delete pre-existing policy rows from upgraded installs; the
 * schema-drop migration is the right place to do that.
 */

import type { IConnectorRepository } from '@agentic-obs/data-layer';
import { createLogger } from '@agentic-obs/server-utils/logging';

const log = createLogger('connectors-backfill');

let noopLogged = false;

export async function backfillKubernetesPolicyDefaults(
  _connectors: IConnectorRepository,
  orgId: string,
): Promise<void> {
  if (!noopLogged) {
    log.debug(
      { orgId },
      'Phase A: skipping policy backfill — always-allow shim active',
    );
    noopLogged = true;
  }
}
