// TraceTopologyBuilder - derives service call graph from distributed trace spans.
//
// Algorithm:
//   For every span that has a parentSpanId, locate the parent span.
//   If the parent and child belong to different services, record a directed
//   "calls" edge: parent.service -> child.service.
//
// Manual edges (edge.manual === true) are never overwritten or removed.

import { TopologyStore } from './TopologyStore.js';
import type { TopologyNode, TopologyEdge } from './types.js';

// — Minimal span interface
// Intentionally narrow so that the real Span type from @agentic-obs/adapters
// satisfies this without introducing a cross-package dependency.

export interface SpanRef {
  spanId: string;
  parentSpanId: string;
  service: string;
}

export interface TraceRef {
  traceId: string;
  spans: SpanRef[];
}

// — Trace provider interface

export interface TraceProvider {
  /** Fetch recent traces for topology derivation. */
  getTraces(): Promise<TraceRef[]>;
}

// — Result summary

export interface IngestResult {
  nodesAdded: number;
  edgesAdded: number;
  tracesProcessed: number;
}

// — Builder

export interface TraceTopologyBuilderConfig {
  /** How often to refresh topology in ms. Used by start(). Default: 60,000 */
  refreshIntervalMs?: number;
}

export class TraceTopologyBuilder {
  private readonly store: TopologyStore;
  private readonly config: Required<TraceTopologyBuilderConfig>;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    store: TopologyStore,
    config: TraceTopologyBuilderConfig = {},
  ) {
    this.store = store;
    this.config = {
      refreshIntervalMs: config.refreshIntervalMs ?? 60_000,
    };
  }

  // — Manual edge management

  /**
   * Add a manually-curated edge between two services.
   * Manual edges are never overwritten by automatic discovery.
   * Ensures both service nodes exist (creating stubs if needed).
   */
  addManualEdge(
    sourceServiceId: string,
    targetServiceId: string,
    metadata?: Record<string, string>,
  ): TopologyEdge {
    this.ensureServiceNode(sourceServiceId);
    this.ensureServiceNode(targetServiceId);
    return this.store.addEdge({
      type: 'calls',
      sourceId: sourceServiceId,
      targetId: targetServiceId,
      manual: true,
      metadata,
    });
  }

  // — Trace ingestion

  /**
   * Process a batch of traces and update the topology store.
   *  - Adds service nodes for every service seen.
   *  - Adds "calls" edges for cross-service parent-child span relationships.
   *  - Skips the edge if a manual edge for the same source-target already exists.
   */
  ingestTraces(traces: TraceRef[]): IngestResult {
    let nodesAdded = 0;
    let edgesAdded = 0;

    // Collect unique service-to-service call pairs
    const callPairs = new Set<string>(); // "sourceId::targetId"
    const servicesSeen = new Set<string>();

    for (const trace of traces) {
      // Build spanId-service lookup for this trace
      const spanServices = new Map<string, string>();
      for (const span of trace.spans) {
        spanServices.set(span.spanId, span.service);
        servicesSeen.add(span.service);
      }

      // Find cross-service calls
      for (const span of trace.spans) {
        if (!span.parentSpanId) continue;
        const parentService = spanServices.get(span.parentSpanId);
        if (!parentService || parentService === span.service) continue;
        callPairs.add(`${parentService}::${span.service}`);
      }
    }

    // Ensure nodes exist for all services
    for (const serviceId of servicesSeen) {
      if (!this.store.getNode(serviceId)) {
        this.store.addNode({
          id: serviceId,
          type: 'service',
          name: serviceId,
          metadata: { source: 'trace-discovery' },
          tags: [],
        });
        nodesAdded++;
      }
    }

    // Add auto-discovered edges (skip if manual edge already covers same pair)
    for (const pair of callPairs) {
      const [sourceId, targetId] = pair.split('::') as [string, string];
      if (this.hasManualEdge(sourceId, targetId)) continue;
      if (this.hasAutoEdge(sourceId, targetId)) continue;

      this.store.addEdge({
        type: 'calls',
        sourceId,
        targetId,
        manual: false,
        metadata: { source: 'trace-discovery' },
      });
      edgesAdded++;
    }

    return { nodesAdded, edgesAdded, tracesProcessed: traces.length };
  }

  // — Periodic refresh

  /**
   * Start periodic topology refresh using the provided TraceProvider.
   * Runs an immediate pass then polls on the configured interval.
   */
  start(provider: TraceProvider): void {
    if (this.timer) return;
    void this.refresh(provider);
    this.timer = setInterval(
      () => void this.refresh(provider),
      this.config.refreshIntervalMs,
    );
  }

  /** Stop periodic refresh. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run a single refresh cycle: fetch traces and ingest them. */
  async refresh(provider: TraceProvider): Promise<IngestResult> {
    const traces = await provider.getTraces();
    return this.ingestTraces(traces);
  }

  // — Helpers

  private ensureServiceNode(serviceId: string): TopologyNode {
    const existing = this.store.getNode(serviceId);
    if (existing) return existing;
    return this.store.addNode({
      id: serviceId,
      type: 'service',
      name: serviceId,
      metadata: { source: 'manual' },
      tags: [],
    });
  }

  private hasManualEdge(sourceId: string, targetId: string): boolean {
    return this.store
      .listEdges('calls')
      .some((e) => e.sourceId === sourceId && e.targetId === targetId && e.manual === true);
  }

  private hasAutoEdge(sourceId: string, targetId: string): boolean {
    return this.store
      .listEdges('calls')
      .some((e) => e.sourceId === sourceId && e.targetId === targetId && !e.manual);
  }
}
