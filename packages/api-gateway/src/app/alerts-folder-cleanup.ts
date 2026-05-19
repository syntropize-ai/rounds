/**
 * One-time idempotent cleanup of the auto-created 'Alerts' system folder —
 * see 2026-05-18 design change to Grafana folder parity.
 *
 * Background: an earlier half-baked fallback synthesized a folder with
 * uid='alerts' / title='Alerts' whenever an alert rule was created without
 * an explicit folder. The Dashboards UI then showed a confusing system
 * folder containing no dashboards. The right Grafana 9+ design is to let
 * alert rules live at the root (folder_uid = NULL) or inherit the active
 * dashboard's folder; no synthetic system folder.
 *
 * This cleanup runs at every boot and, when the folder still has its
 * auto-created title:
 *   1. Migrate every alert rule currently in this folder to folder_uid=NULL.
 *   2. Delete the folder itself.
 *
 * Idempotent: when the folder is already gone (or the user renamed it),
 * the function is a no-op. We never delete a folder the user has renamed
 * — they explicitly took ownership of it.
 */

import type { IFolderRepository } from '@agentic-obs/common';
import type { IAlertRuleRepository } from '@agentic-obs/data-layer';
import { createLogger } from '@agentic-obs/server-utils/logging';

const log = createLogger('alerts-folder-cleanup');

const LEGACY_UID = 'alerts';
const LEGACY_TITLE = 'Alerts';

export async function cleanupLegacyAlertsFolder(
  folders: IFolderRepository,
  alertRules: IAlertRuleRepository,
  orgId: string,
): Promise<void> {
  try {
    const existing = await folders.findByUid(orgId, LEGACY_UID);
    if (!existing) return;
    // Skip if the user renamed the folder — they own it now.
    if (existing.title !== LEGACY_TITLE) return;

    // 1. Move any alert rules out of the legacy folder to root (NULL).
    if (alertRules.update && alertRules.findAll) {
      const result = await alertRules.findAll({});
      const all = 'list' in result ? result.list : result;
      const inLegacy = all.filter((r) => r.folderUid === LEGACY_UID);
      for (const rule of inLegacy) {
        await alertRules.update(rule.id, {
          folderUid: null as unknown as string,
        });
      }
      if (inLegacy.length > 0) {
        log.info(
          { orgId, migratedRules: inLegacy.length },
          'migrated alert rules out of legacy Alerts folder',
        );
      }
    }

    // 2. Delete the legacy folder itself.
    await folders.delete(existing.id);
    log.info(
      { orgId, folderId: existing.id },
      'removed legacy Alerts folder',
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), orgId },
      'cleanupLegacyAlertsFolder failed; will retry on next boot',
    );
  }
}
