/**
 * In-process AdapterRegistry: a simple Map wrapper that holds adapter
 * instances keyed by a caller-chosen `sourceId`, grouped by signal type.
 *
 * This registry is purely synchronous data — no network, no health checks,
 * no lifecycle. Wiring (construct concrete adapters, call register, run
 * health checks) is the parent app's responsibility.
 *
 * Note: there is an unrelated `AdapterRegistry` class in
 * @agentic-obs/adapters that wraps the old `DataAdapter` abstraction.
 * They coexist without import collisions; Phase 2 will decide which one
 * survives.
 */

import type { IMetricsAdapter } from './metrics-adapter.js';
import type { ILogsAdapter } from './logs-adapter.js';
import type { IChangesAdapter } from './changes-adapter.js';

export type SignalType = 'metrics' | 'logs' | 'changes';

export interface DatasourceInfo {
  id: string;
  name: string;
  /** Concrete backend identifier, e.g. 'prometheus' | 'victoria-metrics' | 'loki' | 'change-event'. */
  type: string;
  url?: string;
  signalType: SignalType;
  isDefault?: boolean;
}

export interface AdapterEntry {
  info: DatasourceInfo;
  metrics?: IMetricsAdapter;
  logs?: ILogsAdapter;
  changes?: IChangesAdapter;
}

export class AdapterRegistry {
  private readonly entries = new Map<string, AdapterEntry>();

  /**
   * Register a new datasource. Throws if `entry.info.id` is already registered.
   */
  register(entry: AdapterEntry): void {
    const id = entry.info.id;
    if (this.entries.has(id)) {
      throw new Error(`Datasource '${id}' is already registered`);
    }
    this.entries.set(id, entry);
  }

  get(sourceId: string): AdapterEntry | undefined {
    return this.entries.get(sourceId);
  }

  /**
   * List registered DatasourceInfo values, sorted by `name` (ascending,
   * locale-agnostic). Optionally filter by signal type.
   */
  list(filter?: { signalType?: SignalType }): DatasourceInfo[] {
    const infos: DatasourceInfo[] = [];
    for (const entry of this.entries.values()) {
      if (filter?.signalType && entry.info.signalType !== filter.signalType) {
        continue;
      }
      infos.push(entry.info);
    }
    infos.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return infos;
  }

  /**
   * Return the metrics adapter for `sourceId`, or undefined if the source
   * isn't registered or isn't a metrics source.
   */
  metrics(sourceId: string): IMetricsAdapter | undefined {
    const entry = this.entries.get(sourceId);
    if (!entry || entry.info.signalType !== 'metrics') return undefined;
    return entry.metrics;
  }

  logs(sourceId: string): ILogsAdapter | undefined {
    const entry = this.entries.get(sourceId);
    if (!entry || entry.info.signalType !== 'logs') return undefined;
    return entry.logs;
  }

  changes(sourceId: string): IChangesAdapter | undefined {
    const entry = this.entries.get(sourceId);
    if (!entry || entry.info.signalType !== 'changes') return undefined;
    return entry.changes;
  }
}
