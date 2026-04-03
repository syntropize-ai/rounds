/**
 * Correlation Engine v1 - correlates symptoms and changes within a time
 * window and produces IncidentDraft objects for automated investigation.
 *
 * Correlation rules (any match triggers an Incident):
 * 1. change + symptom on the same service within the window
 * 2. 2 symptoms on the same service within the window
 * 3. symptoms on topology-related services within the window
 */
function symptomMeta(s) {
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
export class NoopTopologyProvider {
    getRelatedServices(_serviceId) {
        return [];
    }
}
export class CorrelationEngine {
    symptoms = [];
    changes = [];
    correlationWindowMs;
    checkIntervalMs;
    topology;
    listeners = [];
    usedSymptomIds = new Set();
    usedChangeIds = new Set();
    timer = null;
    draftCounter = 0;
    constructor(config = {}) {
        this.correlationWindowMs = config.correlationWindowMs ?? 30 * 60 * 1000;
        this.checkIntervalMs = config.checkIntervalMs ?? 60_000;
        this.topology = config.topology ?? new NoopTopologyProvider();
    }
    ingestAnomalyFinding(finding) {
        this.symptoms.push({ source: 'anomaly', finding });
    }
    ingestBurnRateFinding(finding) {
        this.symptoms.push({ source: 'burn_rate', finding });
    }
    ingestChange(change) {
        this.changes.push(change);
    }
    onIncident(listener) {
        this.listeners.push(listener);
    }
    start() {
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
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    correlate() {
        const now = Date.now();
        const cutoff = now - this.correlationWindowMs;
        const activeSymptoms = this.symptoms.filter((s) => {
            const { timestamp } = symptomMeta(s);
            return new Date(timestamp).getTime() >= cutoff;
        });
        const activeChanges = this.changes.filter((c) => new Date(c.timestamp).getTime() >= cutoff);
        const drafts = [];
        for (const change of activeChanges) {
            if (this.usedChangeIds.has(change.id)) {
                continue;
            }
            const relatedSymptoms = activeSymptoms.filter((s) => {
                const serviceId = symptomMeta(s).serviceId;
                return serviceId === change.serviceId && !this.usedSymptomIds.has(this.symptomId(s));
            });
            if (relatedSymptoms.length > 0) {
                const draft = this.buildDraft([change.serviceId], relatedSymptoms, [change], [`This ${change.type} on ${change.serviceId} preceded symptom(s) within ${this.windowLabel()}`]);
                this.markUsed(draft);
                drafts.push(draft);
            }
        }
        for (const [serviceId, group] of this.groupByService(activeSymptoms.filter((s) => !this.usedSymptomIds.has(this.symptomId(s))))) {
            if (group.length >= 2) {
                const draft = this.buildDraft([serviceId], group, [], [`${group.length} symptoms observed on ${serviceId} within ${this.windowLabel()}`]);
                this.markUsed(draft);
                drafts.push(draft);
            }
        }
        const remainingSymptoms = activeSymptoms.filter((s) => !this.usedSymptomIds.has(this.symptomId(s)));
        const serviceIds = [...new Set(remainingSymptoms.map((s) => symptomMeta(s).serviceId))];
        for (let i = 0; i < serviceIds.length; i++) {
            const svcA = serviceIds[i];
            const related = this.topology.getRelatedServices(svcA);
            const linkedServices = serviceIds.filter((svcB) => related.includes(svcB));
            if (linkedServices.length > 0) {
                const affectedServices = [svcA, ...linkedServices];
                const group = remainingSymptoms.filter((s) => affectedServices.includes(symptomMeta(s).serviceId) &&
                    !this.usedSymptomIds.has(this.symptomId(s)));
                if (group.length >= 2) {
                    const draft = this.buildDraft(affectedServices, group, [], [`Symptoms on topology-linked services: ${affectedServices.join(', ')}`]);
                    this.markUsed(draft);
                    drafts.push(draft);
                }
            }
        }
        this.pruneExpired();
        return drafts;
    }
    buildDraft(affectedServices, symptoms, changes, correlationReasons) {
        const severity = this.deriveSeverity(symptoms);
        const uniqueServices = [...new Set(affectedServices)];
        const primaryService = uniqueServices[0] ?? 'unknown';
        const firstChange = changes[0];
        const title = firstChange
            ? `${primaryService}: ${firstChange.type} may have caused ${symptoms.length} symptom(s)`
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
    deriveSeverity(symptoms) {
        const rank = {
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
            if (r > highest)
                highest = r;
        }
        if (highest >= 4)
            return 'P1';
        if (highest >= 3)
            return 'P2';
        if (highest >= 2)
            return 'P3';
        return 'P4';
    }
    groupByService(symptoms) {
        const map = new Map();
        for (const s of symptoms) {
            const { serviceId } = symptomMeta(s);
            const group = map.get(serviceId) ?? [];
            group.push(s);
            map.set(serviceId, group);
        }
        return map;
    }
    symptomId(s) {
        return s.source === 'anomaly' ? s.finding.id : s.finding.id;
    }
    markUsed(draft) {
        for (const s of draft.symptoms) {
            this.usedSymptomIds.add(this.symptomId(s));
        }
        for (const c of draft.changes) {
            this.usedChangeIds.add(c.id);
        }
    }
    emit(draft) {
        for (const listener of this.listeners) {
            listener(draft);
        }
    }
    windowLabel() {
        const minutes = Math.round(this.correlationWindowMs / 60_000);
        return `${minutes}m window`;
    }
    pruneExpired() {
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
//# sourceMappingURL=correlation-engine.js.map