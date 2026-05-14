/**
 * Repository interface for per-user-per-dashboard variable inference acks
 * (Wave 2 / Step 4).
 *
 * When a user lands on a dashboard with `?_inf_<key>=...` URL params we
 * surface a banner so they can confirm those bindings before any panel
 * query fires with them. Once they click "Use these" we persist a row
 * here keyed by (user, dashboard, hash-of-vars). On subsequent opens
 * with the same hash we apply silently. If the hash changes (e.g. the
 * user navigates from a different service context) the banner returns.
 *
 * Implementations live in:
 *   packages/data-layer/src/repository/sqlite/dashboard-variable-ack.ts
 *   packages/data-layer/src/repository/postgres/dashboard-variable-ack.ts
 *   packages/data-layer/src/repository/memory/dashboard-variable-ack.ts
 */

export interface DashboardVariableAck {
  id: string;
  orgId: string;
  userId: string;
  dashboardUid: string;
  varsHash: string;
  ackedAt: string;
}

export interface IDashboardVariableAckRepository {
  /**
   * Returns the existing ack row, or `null` if none. Callers typically only
   * care about the boolean (`!= null`).
   */
  findAck(
    userId: string,
    dashboardUid: string,
    varsHash: string,
  ): Promise<DashboardVariableAck | null>;

  /**
   * Idempotent upsert keyed on (user, dashboard, hash). Re-acking the same
   * variable set is a no-op (preserves the original `acked_at`).
   */
  ackVariables(input: {
    orgId: string;
    userId: string;
    dashboardUid: string;
    varsHash: string;
  }): Promise<DashboardVariableAck>;

  /**
   * Clear every ack for one dashboard. Intended to be called when the
   * dashboard's variable schema changes server-side; not currently wired
   * to any caller — kept on the interface so the wiring is local when a
   * future change needs it.
   */
  clearAcksForDashboard(dashboardUid: string): Promise<void>;
}
