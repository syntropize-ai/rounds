/**
 * Proactive Pipeline Bootstrap
 *
 * Wires together the four proactive monitoring components:
 * AnomalyDetector -> CorrelationEngine -> IncidentStore -> FeedStore
 * SloBurnMonitor -> CorrelationEngine -> IncidentStore -> FeedStore
 * ChangeWatcher -> CorrelationEngine -> IncidentStore -> FeedStore
 *
 * Also provides a TopologyStoreAdapter that bridges the data-layer
 * TopologyStore to the CorrelationEngine's TopologyProvider interface.
 *
 * Usage (in startServer):
 *   const pipeline = createProactivePipeline({ feed: feedStore, incidents: incidentStore });
 *   pipeline.start();
 */
import { createLogger } from '@agentic-obs/common';
const log = createLogger('proactive-pipeline');
// -- TopologyStoreAdapter
/**
 * Bridges the data-layer TopologyStore to the CorrelationEngine's
 * TopologyProvider interface, returning all direct upstream and downstream
 * neighbour IDs for a given serviceId.
 */
export class TopologyStoreAdapter {
    store;
    constructor(store) {
        this.store = store;
    }
    getRelatedServices(serviceId) {
        const downstream = this.store.getDownstream(serviceId).map((d) => d.node.id);
        const upstream = this.store.getUpstream(serviceId).map((u) => u.node.id);
        return [...new Set([...downstream, ...upstream])];
    }
}
// -- Severity mapping helpers
function draftSeverityToFeed(severity) {
    switch (severity) {
        case 'P1':
            return 'critical';
        case 'P2':
            return 'high';
        case 'P3':
            return 'medium';
        default:
            return 'low';
    }
}
// -- Factory
/**
 * Wire the proactive components together and return a handle to start/stop
 * the whole pipeline.
 *
 * All wiring is set up synchronously; call `start()` to begin polling.
 */
export function createProactivePipeline(components, deps) {
    const { feed, incidents } = deps;
    const { anomalyDetector, sloBurnMonitor, changeWatcher, correlationEngine, alertRuleEvaluator } = components;
    // -- AnomalyDetector -> CorrelationEngine -> Feed
    if (anomalyDetector) {
        anomalyDetector.onFinding((finding) => {
            try {
                correlationEngine.ingestAnomalyFinding(finding);
                feed.add('anomaly_detected', `Anomaly: ${finding.metricName} on ${finding.serviceId}`, finding.message, finding.severity);
            }
            catch (err) {
                log.error({ err }, 'anomaly callback error');
            }
        });
    }
    // -- SloBurnMonitor -> CorrelationEngine -> Feed
    if (sloBurnMonitor) {
        sloBurnMonitor.onFinding((finding) => {
            try {
                correlationEngine.ingestBurnRateFinding(finding);
                feed.add('anomaly_detected', `SLO burn: ${finding.metricName} on ${finding.serviceId} (${finding.burnRate.toFixed(1)}x)`, finding.message, finding.severity);
            }
            catch (err) {
                log.error({ err }, 'slo-burn callback error');
            }
        });
    }
    // -- ChangeWatcher -> CorrelationEngine -> Feed
    if (changeWatcher) {
        changeWatcher.onFinding((watcherFinding) => {
            try {
                const { change } = watcherFinding;
                correlationEngine.ingestChange(change);
                feed.add('change_impact', `Change: ${change.type} on ${change.serviceId}`, change.description, 'medium');
            }
            catch (err) {
                log.error({ err }, 'change-watcher callback error');
            }
        });
    }
    // -- CorrelationEngine -> IncidentStore + Feed
    correlationEngine.onIncident((draft) => {
        try {
            const incident = incidents.create({
                title: draft.title,
                severity: draft.severity,
                services: draft.affectedServices,
            });
            // Add timeline entry describing why these signals were correlated
            incidents.addTimelineEntry(incident.id, 'investigation_created', `Proactive correlation: ${draft.correlationReasons.join(', ')}`, 'system', 'proactive-pipeline', undefined, {
                correlationReasons: draft.correlationReasons,
                symptomCount: draft.symptoms.length,
                changeCount: draft.changes.length,
            });
            feed.add('incident_created', draft.title, `Severity: ${draft.severity}. Services: ${draft.affectedServices.join(', ')}. ${draft.correlationReasons[0] ?? ''}`, draftSeverityToFeed(draft.severity), incident.id);
        }
        catch (err) {
            log.error({ err }, 'incident callback error');
        }
    });
    // -- AlertRuleEvaluator -> Feed + CorrelationEngine
    if (alertRuleEvaluator) {
        alertRuleEvaluator.onAlert((event) => {
            try {
                feed.add('anomaly_detected', `Alert: ${event.ruleName}`, event.message, event.severity);
                log.info({ ruleId: event.ruleId, severity: event.severity }, `Alert firing: ${event.ruleName}`);
            }
            catch (err) {
                log.error({ err }, 'alert callback error');
            }
        });
        alertRuleEvaluator.onResolve((event) => {
            try {
                feed.add('anomaly_detected', `Resolved: ${event.ruleName}`, event.message, 'low');
                log.info({ ruleId: event.ruleId }, `Alert resolved: ${event.ruleName}`);
            }
            catch (err) {
                log.error({ err }, 'alert resolve callback error');
            }
        });
    }
    // -- Lifecycle
    return {
        start() {
            anomalyDetector?.start();
            sloBurnMonitor?.start();
            changeWatcher?.start();
            correlationEngine.start();
            alertRuleEvaluator?.start();
        },
        stop() {
            anomalyDetector?.stop();
            sloBurnMonitor?.stop();
            changeWatcher?.stop();
            correlationEngine.stop();
            alertRuleEvaluator?.stop();
        },
    };
}
//# sourceMappingURL=proactive-pipeline.js.map