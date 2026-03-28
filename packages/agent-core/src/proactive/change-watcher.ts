/**
 * Change Watcher - polls ChangeEventStore for new change events and
 * automatically triggers investigations via AgentOrchestrator.
 *
 * Follows the same start/stop/check pattern as SloBurnMonitor.
 */

import type { Change } from '@agentic-obs/common';
import type { OrchestratorOutput } from '../orchestrator/types.js';

export interface ChangeEventStore {
  query(input: { startTime: Date; endTime: Date }): Change[];
}

export interface OrchestratorRunner {
  run(input: {
    message: string;
    tenantId: string;
    userId: string;
  }): Promise<OrchestratorOutput>;
}

export interface ChangeWatcherFinding {
  change: Change;
  orchestratorOutput: OrchestratorOutput;
  triggeredAt: string;
}

export interface ChangeWatcherConfig {
  pollIntervalMs?: number;
  lookbackWindowMs?: number;
  filter?: {
    services?: string[];
    changeTypes?: string[];
  };
  maxSeenIds?: number;
  tenantId: string;
  userId: string;
}

export class ChangeWatcher {
  private readonly store: ChangeEventStore;
  private readonly orchestrator: OrchestratorRunner;
  private readonly config: Required<Omit<ChangeWatcherConfig, 'filter'>> & {
    filter: NonNullable<ChangeWatcherConfig['filter']>;
  };
  private readonly seenIds = new Set<string>();
  /** Insertion-order record used for FIFO eviction when seenIds exceeds maxSeenIds. */
  private readonly seenIdsOrder: string[] = [];
  private readonly listeners: Array<(finding: ChangeWatcherFinding) => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    store: ChangeEventStore,
    orchestrator: OrchestratorRunner,
    config: ChangeWatcherConfig,
  ) {
    this.store = store;
    this.orchestrator = orchestrator;
    const pollIntervalMs = config.pollIntervalMs ?? 60_000;
    this.config = {
      pollIntervalMs,
      lookbackWindowMs: config.lookbackWindowMs ?? pollIntervalMs * 2,
      filter: config.filter ?? {},
      maxSeenIds: config.maxSeenIds ?? 10_000,
      tenantId: config.tenantId,
      userId: config.userId,
    };
  }

  onFinding(listener: (finding: ChangeWatcherFinding) => void): void {
    this.listeners.push(listener);
  }

  start(): void {
    if (this.timer) {
      return;
    }
    void this.check();
    this.timer = setInterval(() => void this.check(), this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async check(): Promise<ChangeWatcherFinding[]> {
    const now = Date.now();
    const endTime = new Date(now);
    const startTime = new Date(now - this.config.lookbackWindowMs);

    const changes = this.store.query({ startTime, endTime });
    const newChanges = changes.filter((c) => {
      if (this.seenIds.has(c.id)) return false;
      return this.matchesFilter(c);
    });

    const findings: ChangeWatcherFinding[] = [];
    for (const change of newChanges) {
      this.addSeenId(change.id);
      const output = await this.orchestrator.run(this.buildInput(change));
      const finding: ChangeWatcherFinding = {
        change,
        orchestratorOutput: output,
        triggeredAt: new Date().toISOString(),
      };
      findings.push(finding);
      for (const listener of this.listeners) {
        listener(finding);
      }
    }

    return findings;
  }

  private matchesFilter(change: Change): boolean {
    const { services, changeTypes } = this.config.filter;
    if (services && services.length > 0 && !services.includes(change.serviceId)) {
      return false;
    }
    if (changeTypes && changeTypes.length > 0 && !changeTypes.includes(change.type)) {
      return false;
    }
    return true;
  }

  private buildInput(change: Change): { message: string; tenantId: string; userId: string } {
    return {
      message: `Investigate ${change.type} change on ${change.serviceId}: ${change.description ?? ''}`,
      tenantId: this.config.tenantId,
      userId: this.config.userId,
    };
  }

  private addSeenId(id: string): void {
    if (this.seenIds.has(id)) {
      return;
    }
    this.seenIds.add(id);
    this.seenIdsOrder.push(id);
    while (this.seenIds.size > this.config.maxSeenIds) {
      const oldest = this.seenIdsOrder.shift();
      if (oldest !== undefined) {
        this.seenIds.delete(oldest);
      }
    }
  }
}
