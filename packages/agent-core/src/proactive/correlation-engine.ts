/**
 * Correlation Engine v1 - correlates symptoms and changes within a time
 * window and produces IncidentDraft objects for automated investigation.
 *
 * Correlation rules (any match triggers an Incident):
 * 1. change + symptom on the same service within the window
 * 2. 2 symptoms on the same service within the window
 * 3. symptoms on topology-related services within the window
 */

import type { Change } from '@agentic-obs/common';
import type { AnomalyFinding, AnomalySeverity } from './anomaly-detector.js';
import type { BurnRateFinding } from './slo-burn-monitor.js';

export type Symptom =
  | { source: 'anomaly'; finding: AnomalyFinding }
  | { source: 'burn_rate'; finding: BurnRateFinding };

export interface IncidentDraft {
  id: string;
  title: string;
  severity: 'P1' | 'P2' | 'P3' | 'P4';
  affectedServices: string[];
  symptoms: Symptom[];
  changes: Change[];
  correlationReasons: string[];
  createdAt: string;
}

export interface TopologyProvider {
  getRelatedServices(serviceId: string): string[];
}

export interface CorrelationEngineConfig {
  correlationWindowMs?: number;
  checkIntervalMs?: number;
  topology?: TopologyProvider;
}

function symptomMeta(
  s: Symptom,
): { serviceId: string; timestamp: string; severity: AnomalySeverity } {
  if (s.source === 'anomaly') {
    return {
      serviceId: s.finding.serviceId,
      timestamp: s.finding.timestamp,
      severity: s.finding.severity,
    };
  }
  return {
    serviceId: s.finding.serviceId,
    timestamp: s.finding.timestamp,
    severity: s.finding.severity,
  };
}

/** No-op provider when topology information is unavailable. */
export class NoopTopologyProvider implements TopologyProvider {
  getRelatedServices(_serviceId: string): string[] {
    return [];
  }
}

export class CorrelationEngine {
  private symptoms: Symptom[] = [];
  private changes: Change[] = [];
  private readonly correlationWindowMs: number;
  private readonly checkIntervalMs: number;
  private readonly topology: TopologyProvider;
  private readonly listeners: Array<(draft: IncidentDraft) => void> = [];
  private readonly usedSymptomIds = new Set<string>();
  private readonly usedChangeIds = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private draftCounter = 0;

  constructor(config: CorrelationEngineConfig = {}) {
    this.correlationWindowMs = config.correlationWindowMs ?? 30 * 60 * 1000;
    this.checkIntervalMs = config.checkIntervalMs ?? 60_000;
    this.topology = config.topology ?? new NoopTopologyProvider();
  }

  ingestAnomalyFinding(finding: AnomalyFinding): void {
    this.symptoms.push({ source: 'anomaly', finding });
  }

  ingestBurnRateFinding(finding: BurnRateFinding): void {
    this.symptoms.push({ source: 'burn_rate', finding });
  }

  ingestChange(change: Change): void {
    this.changes.push(change);
  }

  onIncident(listener: (draft: IncidentDraft) => void): void {
    this.listeners.push(listener);
  }

  start(): void {
    if (this.timer) {
      return;
    }
    const drafts = this.correlate();
    for (const draft of drafts) {
      this.emit(draft);
    }
    this.timer = setInterval(() => {
      const newDrafts = this.correlate();
      for (const draft of newDrafts) {
        this.emit(draft);
      }
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  correlate(): IncidentDraft[] {
    const now = Date.now();
    const cutoff = now - this.correlationWindowMs;
    const activeSymptoms = this.symptoms.filter((s) => {
      const { timestamp } = symptomMeta(s);
      return new Date(timestamp).getTime() >= cutoff;
    });
    const activeChanges = this.changes.filter((c) => new Date(c.timestamp).getTime() >= cutoff);

    const drafts: IncidentDraft[] = [];

    for (const change of activeChanges) {
      if (this.usedChangeIds.has(change.id)) {
        continue;
      }
      const relatedSymptoms = activeSymptoms.filter((s) => {
        const serviceId = symptomMeta(s).serviceId;
        return serviceId === change.serviceId && !this.usedSymptomIds.has(this.symptomId(s));
      });
      if (relatedSymptoms.length > 0) {
        const draft = this.buildDraft(
          [change.serviceId],
          relatedSymptoms,
          [change],
          [`This ${change.type} on ${change.serviceId} preceded symptom(s) within ${this.windowLabel()}`],
        );
        this.markUsed(draft);
        drafts.push(draft);
      }
    }

    for (const [serviceId, group] of this.groupByService(
      activeSymptoms.filter((s) => !this.usedSymptomIds.has(this.symptomId(s))),
    )) {
      if (group.length >= 2) {
        const draft = this.buildDraft(
          [serviceId],
          group,
          [],
          [`${group.length} symptoms observed on ${serviceId} within ${this.windowLabel()}`],
        );
        this.markUsed(draft);
        drafts.push(draft);
      }
    }

    const remainingSymptoms = activeSymptoms.filter(
      (s) => !this.usedSymptomIds.has(this.symptomId(s)),
    );
    const serviceIds = [...new Set(remainingSymptoms.map((s) => symptomMeta(s).serviceId))];
    for (let i = 0; i < serviceIds.length; i++) {
      const svcA = serviceIds[i];
      const related = this.topology.getRelatedServices(svcA);
      const linkedServices = serviceIds.filter((svcB) => related.includes(svcB));
      if (linkedServices.length > 0) {
        const affectedServices = [svcA, ...linkedServices];
        const group = remainingSymptoms.filter(
          (s) =>
            affectedServices.includes(symptomMeta(s).serviceId) &&
            !this.usedSymptomIds.has(this.symptomId(s)),
        );
        if (group.length >= 2) {
          const draft = this.buildDraft(
            affectedServices,
            group,
            [],
            [`Symptoms on topology-linked services: ${affectedServices.join(', ')}`],
          );
          this.markUsed(draft);
          drafts.push(draft);
        }
      }
    }

    this.pruneExpired();
    return drafts;
  }

  private buildDraft(
    affectedServices: string[],
    symptoms: Symptom[],
    changes: Change[],
    correlationReasons: string[],
  ): IncidentDraft {
    const severity = this.deriveSeverity(symptoms);
    const uniqueServices = [...new Set(affectedServices)];
    const primaryService = uniqueServices[0] ?? 'unknown';
    const title =
      changes.length > 0
        ? `${primaryService}: ${changes[0].type} may have caused ${symptoms.length} symptom(s)`
        : `${primaryService}: ${symptoms.length} correlated symptom(s) detected`;

    return {
      id: `incident-draft-${++this.draftCounter}`,
      title,
      severity,
      affectedServices: uniqueServices,
      symptoms,
      changes,
      correlationReasons,
      createdAt: new Date().toISOString(),
    };
  }

  private deriveSeverity(symptoms: Symptom[]): 'P1' | 'P2' | 'P3' | 'P4' {
    const rank: Record<AnomalySeverity, number> = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1,
      info: 0,
    };

    let highest = 0;
    for (const s of symptoms) {
      const { severity } = symptomMeta(s);
      const r = rank[severity] ?? 0;
      if (r > highest) highest = r;
    }
    if (highest >= 4) return 'P1';
    if (highest >= 3) return 'P2';
    if (highest >= 2) return 'P3';
    return 'P4';
  }

  private groupByService(symptoms: Symptom[]): Map<string, Symptom[]> {
    const map = new Map<string, Symptom[]>();
    for (const s of symptoms) {
      const { serviceId } = symptomMeta(s);
      const group = map.get(serviceId) ?? [];
      group.push(s);
      map.set(serviceId, group);
    }
    return map;
  }

  private symptomId(s: Symptom): string {
    return s.source === 'anomaly' ? s.finding.id : s.finding.id;
  }

  private markUsed(draft: IncidentDraft): void {
    for (const s of draft.symptoms) {
      this.usedSymptomIds.add(this.symptomId(s));
    }
    for (const c of draft.changes) {
      this.usedChangeIds.add(c.id);
    }
  }

  private emit(draft: IncidentDraft): void {
    for (const listener of this.listeners) {
      listener(draft);
    }
  }

  private windowLabel(): string {
    const minutes = Math.round(this.correlationWindowMs / 60_000);
    return `${minutes}m window`;
  }

  private pruneExpired(): void {
    const cutoff = Date.now() - this.correlationWindowMs;

    for (let i = this.symptoms.length - 1; i >= 0; i--) {
      const s = this.symptoms[i];
      if (new Date(symptomMeta(s).timestamp).getTime() < cutoff) {
        this.usedSymptomIds.delete(this.symptomId(s));
        this.symptoms.splice(i, 1);
      }
    }

    for (let i = this.changes.length - 1; i >= 0; i--) {
      const c = this.changes[i];
      if (new Date(c.timestamp).getTime() < cutoff) {
        this.usedChangeIds.delete(c.id);
        this.changes.splice(i, 1);
      }
    }
  }
}
