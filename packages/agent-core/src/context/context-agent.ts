// Context Agent - assembles SystemContext from topology, changes, SLO, and incidents

import type { StructuredIntent } from '@agentic-obs/common';
import type { TopologyStore } from '@agentic-obs/data-layer';
import type { ChangeEventStore } from '@agentic-obs/adapters';
import type { Agent, AgentContext, AgentResult } from '../index.js';
import type { SystemContext, SloStatusProvider, IncidentProvider } from './types.js';

const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface ContextAgentDeps {
  topologyStore: TopologyStore;
  changeEventStore: ChangeEventStore;
  sloProvider?: SloStatusProvider;
  incidentProvider?: IncidentProvider;
  changeLookbackMs?: number;
}

export class ContextAgent implements Agent<StructuredIntent, SystemContext> {
  readonly name = 'context';
  private readonly topology: TopologyStore;
  private readonly changes: ChangeEventStore;
  private readonly sloProvider?: SloStatusProvider;
  private readonly incidentProvider?: IncidentProvider;
  private readonly changeLookbackMs: number;

  constructor(deps: ContextAgentDeps) {
    this.topology = deps.topologyStore;
    this.changes = deps.changeEventStore;
    this.sloProvider = deps.sloProvider;
    this.incidentProvider = deps.incidentProvider;
    this.changeLookbackMs = deps.changeLookbackMs ?? DEFAULT_LOOKBACK_MS;
  }

  async run(input: StructuredIntent, _context: AgentContext): Promise<AgentResult<SystemContext>> {
    try {
      const ctx = await this.collect(input);
      return { success: true, data: ctx };
    } catch (err) {
      return {
        success: false,
        error: `ContextAgent failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async collect(intent: StructuredIntent): Promise<SystemContext> {
    const entity = intent.entity;
    const collectedAt = new Date().toISOString();

    const rangeEnd = new Date(intent.timeRange.end);
    const rangeStart = new Date(
      Math.min(
        new Date(intent.timeRange.start).getTime(),
        rangeEnd.getTime() - this.changeLookbackMs,
      ),
    );

    const canonicalId = this.resolveEntityId(entity);

    const [topologyCtx, recentChanges, sloStatus, historicalIncidents] = await Promise.all([
      this.collectTopology(entity, canonicalId),
      this.collectChanges(canonicalId, rangeStart, rangeEnd),
      this.collectSloStatus(entity, intent),
      this.collectIncidents(entity, this.changeLookbackMs),
    ]);

    return {
      entity,
      topology: topologyCtx,
      recentChanges,
      sloStatus,
      historicalIncidents,
      collectedAt,
    };
  }

  private resolveEntityId(entity: string): string {
    const byName = this.topology.findNodeByName(entity);
    if (byName) return byName.id;

    const byId = this.topology.getNode(entity);
    if (byId) return byId.id;

    const lower = entity.toLowerCase();
    const nodes = this.topology.listNodes();

    const startsWithMatch = nodes.find((n) =>
      n.name.toLowerCase().startsWith(lower) ||
      lower.startsWith(n.name.toLowerCase()),
    );
    if (startsWithMatch) return startsWithMatch.id;

    const includesMatch = nodes.find((n) =>
      n.name.toLowerCase().includes(lower) ||
      lower.includes(n.name.toLowerCase()),
    );
    if (includesMatch) return includesMatch.id;

    return entity;
  }

  private collectTopology(entity: string, resolvedId: string) {
    const node =
      this.topology.findNodeByName(entity) ??
      this.topology.getNode(resolvedId) ??
      null;

    const nodeId = node?.id ?? resolvedId;
    const dependencies = this.topology.getServiceDependencies(nodeId);
    const dependents = this.topology.getServiceDependents(nodeId);

    return Promise.resolve({ node, dependencies, dependents });
  }

  private collectChanges(canonicalId: string, start: Date, end: Date): Promise<import('@agentic-obs/common').Change[]> {
    const results = this.changes.query({
      serviceId: canonicalId,
      startTime: start,
      endTime: end,
    });
    return Promise.resolve(results);
  }

  private async collectSloStatus(entity: string, intent: StructuredIntent) {
    if (!this.sloProvider) {
      return [];
    }
    const window = this.deriveWindow(intent);
    return this.sloProvider.getStatus(entity, window);
  }

  private async collectIncidents(entity: string, lookbackMs: number) {
    if (!this.incidentProvider) return [];
    return this.incidentProvider.getRecent(entity, lookbackMs);
  }

  private deriveWindow(intent: StructuredIntent): string {
    const durationMs =
      new Date(intent.timeRange.end).getTime() -
      new Date(intent.timeRange.start).getTime();
    const hours = Math.round(durationMs / (60 * 60 * 1000));
    if (hours <= 1) return '1h';
    if (hours <= 6) return '6h';
    if (hours <= 24) return '24h';
    return `${hours}h`;
  }
}
