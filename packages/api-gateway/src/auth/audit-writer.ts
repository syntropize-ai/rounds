/**
 * AuditWriter — fire-and-forget persistence of audit events.
 *
 * Writes never block the primary operation. On failure the error is logged
 * and swallowed. This matches the guarantee in
 * docs/auth-perm-design/02-authentication.md §audit-writer: "if the audit
 * table is down, the action still succeeds."
 */

import type {
  IAuditLogRepository,
  NewAuditLogEntry,
} from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';

const log = createLogger('audit-writer');

export type AuditLogInput = NewAuditLogEntry;

export class AuditWriter {
  constructor(private readonly repo: IAuditLogRepository) {}

  /**
   * Log an event. Returns a Promise so callers can await when they want
   * ordered assertions (tests), but the normal path is to ignore it. Errors
   * are logged and never rethrown.
   */
  async log(entry: AuditLogInput): Promise<void> {
    try {
      await this.repo.log(entry);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : err, action: entry.action },
        'audit log write failed',
      );
    }
  }
}

/**
 * Retention pruner — daily cron deletes rows older than the configured number
 * of days. Default 90 (Grafana's default). Configurable via
 * `AUDIT_RETENTION_DAYS`.
 */
export function auditRetentionDays(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const v = env['AUDIT_RETENTION_DAYS'];
  if (!v) return 90;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 90;
}

export async function pruneAuditLog(
  repo: IAuditLogRepository,
  days = 90,
  now = () => Date.now(),
): Promise<number> {
  const cutoff = new Date(now() - days * 24 * 60 * 60 * 1000).toISOString();
  return repo.deleteOlderThan(cutoff);
}

export function startAuditPruneCron(
  repo: IAuditLogRepository,
  days = 90,
  intervalMs = 24 * 60 * 60 * 1000,
): () => void {
  const t = setInterval(() => {
    void pruneAuditLog(repo, days);
  }, intervalMs);
  if (typeof t.unref === 'function') t.unref();
  return () => clearInterval(t);
}
