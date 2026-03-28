// Context Agent - output types and provider interfaces

import type { Change } from '@agentic-obs/common';
import type { TopologyNode, DependencyInfo } from '@agentic-obs/data-layer';

export type SloHealthStatus = 'healthy' | 'at_risk' | 'breaching' | 'unknown';

export interface SloStatus {
  serviceId: string;
  metricName: string;
  status: SloHealthStatus;
  currentValue?: number;
  threshold?: number;
  /** e.g. "5m", "1h" */
  window: string;
}

export interface HistoricalIncident {
  id: string;
  title: string;
  serviceId: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  startedAt: string;
  resolvedAt?: string;
  summary?: string;
}

export interface TopologyContext {
  /** The node for the target entity, or null if not found in topology */
  node: TopologyNode | null;
  /** Direct downstream dependencies (services this entity calls) */
  dependencies: DependencyInfo[];
  /** Direct upstream callers (services that call this entity) */
  dependents: DependencyInfo[];
}

export interface SystemContext {
  entity: string;
  topology: TopologyContext;
  recentChanges: Change[];
  sloStatus: SloStatus[];
  historicalIncidents: HistoricalIncident[];
  /** ISO-8601 timestamp when this context was collected */
  collectedAt: string;
}

export interface SloStatusProvider {
  getStatus(serviceId: string, window: string): Promise<SloStatus[]>;
}

export interface IncidentProvider {
  getRecent(serviceId: string, lookbackMs: number): Promise<HistoricalIncident[]>;
}
