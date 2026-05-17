/**
 * Panel-event types — behavior tracking for dashboard / panel CRUD.
 *
 * Recorded fire-and-forget by the dashboard router after each successful
 * mutation. Used offline to mine lint-rule data ("queries that get deleted
 * within 24h", "shapes that keep getting cloned", …). No live analysis lives
 * in the gateway — this module is the collection pipeline only.
 */

export type PanelEventType = 'created' | 'edited' | 'deleted' | 'cloned' | 'viewed';

export interface PanelEvent {
  id: string;
  orgId: string;
  dashboardId: string;
  panelId: string;
  eventType: PanelEventType;
  /** Full panel spec at this point in time, serialized as JSON in storage. */
  panelSnapshot: unknown;
  /**
   * Normalized PromQL signature for grouping. Picked from the first query in
   * the panel snapshot when available; null when the panel has no PromQL
   * (e.g. text panels, non-prometheus visualizations).
   */
  querySignature: string | null;
  /** Duplicated from snapshot for cheap GROUP BY without re-parsing JSON. */
  vizType: string | null;
  aiGenerated: boolean;
  actorId: string | null;
  sessionId: string | null;
  createdAt: string;
}

export interface PanelEventAggregateRow {
  signature: string;
  vizType: string | null;
  count: number;
  /** Rows in the bucket whose event_type='deleted' AND created within 24h of
   *  the matching 'created' event for the same panel_id. */
  deletedWithin24h: number;
}

export interface AggregateBySignatureOptions {
  since?: string;
  eventTypes?: string[];
}

export interface IPanelEventRepository {
  record(input: Omit<PanelEvent, 'id' | 'createdAt'>): Promise<{ id: string }>;
  findByDashboard(orgId: string, dashboardId: string, limit?: number): Promise<PanelEvent[]>;
  findByQuerySignature(orgId: string, sig: string, limit?: number): Promise<PanelEvent[]>;
  aggregateBySignature(
    orgId: string,
    opts: AggregateBySignatureOptions,
  ): Promise<PanelEventAggregateRow[]>;
}
