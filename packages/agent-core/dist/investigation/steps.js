/**
 * Step executors for the Investigation Agent.
 *
 * Each executor runs one investigation step and returns a StepFinding.
 * Steps try to query the DataAdapter if available; otherwise they derive
 * findings from the SystemContext alone (topology, changes, SLO status).
 */
async function safeAdapterQuery(ctx, metric) {
    if (!ctx.adapter || ctx.queryBudget.count >= ctx.queryBudget.max) {
        return { value: undefined };
    }
    try {
        const result = await ctx.adapter.query({
            entity: ctx.intent.entity,
            metric,
            timerange: {
                start: new Date(ctx.intent.timeRange.start),
                end: new Date(ctx.intent.timeRange.end),
            },
        });
        ctx.queryBudget.count++;
        const series = result.data;
        const firstPoint = series?.[0]?.points?.[0];
        return {
            value: firstPoint?.value,
            replayableQuery: {
                query: result.queryUsed,
                queryLanguage: 'promql',
                adapterName: result.metadata.adapterName,
            },
        };
    }
    catch {
        return { value: undefined };
    }
}
async function safeAdapterQueryRaw(ctx, metric, queryLanguage, filters) {
    if (!ctx.adapter || ctx.queryBudget.count >= ctx.queryBudget.max) {
        return { rawData: undefined };
    }
    const supported = ctx.adapter.meta?.().supportedMetrics;
    if (supported && !supported.includes(metric)) {
        return { rawData: undefined };
    }
    try {
        const result = await ctx.adapter.query({
            entity: ctx.intent.entity,
            metric,
            timerange: {
                start: new Date(ctx.intent.timeRange.start),
                end: new Date(ctx.intent.timeRange.end),
            },
            filters,
        });
        ctx.queryBudget.count++;
        return {
            rawData: result.data,
            replayableQuery: {
                query: result.queryUsed,
                queryLanguage,
                adapterName: result.metadata.adapterName,
                params: filters,
            },
        };
    }
    catch {
        return { rawData: undefined };
    }
}
async function compareLatencyVsBaseline(ctx) {
    const { value: current, replayableQuery } = await safeAdapterQuery(ctx, 'p95_latency');
    const slo = ctx.context.sloStatus.find((s) => s.metricName === 'p95_latency' || s.metricName.includes('latency'));
    if (current !== undefined && slo?.threshold !== undefined) {
        const deviationRatio = (current - slo.threshold) / slo.threshold;
        const isAnomaly = current > slo.threshold * 1.2;
        return {
            stepType: 'compare_latency_vs_baseline',
            summary: isAnomaly
                ? `p95 latency ${current.toFixed(2)} exceeds threshold ${slo.threshold} by ${((deviationRatio || 0) * 100).toFixed(0)}%`
                : `p95 latency ${current.toFixed(2)} is within threshold`,
            value: current,
            baseline: slo.threshold,
            deviationRatio,
            isAnomaly,
            replayableQuery,
        };
    }
    const latencySlo = ctx.context.sloStatus.find((s) => s.metricName.includes('latency'));
    const isAnomaly = latencySlo?.status === 'breaching' || latencySlo?.status === 'at_risk';
    return {
        stepType: 'compare_latency_vs_baseline',
        summary: latencySlo
            ? `Latency baseline data unavailable; latency SLO status is ${latencySlo.status}`
            : 'No latency baseline data available',
        value: latencySlo?.currentValue,
        baseline: latencySlo?.threshold,
        isAnomaly,
    };
}
async function checkErrorRate(ctx) {
    const { value: current, replayableQuery } = await safeAdapterQuery(ctx, 'error_rate');
    const slo = ctx.context.sloStatus.find((s) => s.metricName === 'error_rate');
    if (current !== undefined) {
        const threshold = slo?.threshold ?? 0.01;
        const isAnomaly = current > threshold;
        return {
            stepType: 'check_error_rate',
            summary: isAnomaly
                ? `Error rate ${(current * 100).toFixed(2)}% exceeds threshold ${(threshold * 100).toFixed(2)}%`
                : `Error rate ${(current * 100).toFixed(2)}% is within normal range`,
            value: current,
            baseline: threshold,
            deviationRatio: threshold > 0 ? (current - threshold) / threshold : 0,
            isAnomaly,
            replayableQuery,
        };
    }
    const errorSlo = ctx.context.sloStatus.find((s) => s.metricName.includes('error'));
    const isAnomaly = errorSlo?.status === 'breaching' || errorSlo?.status === 'at_risk';
    return {
        stepType: 'check_error_rate',
        summary: errorSlo
            ? `Error rate SLO status: ${errorSlo.status}`
            : 'No error rate data available',
        value: errorSlo?.currentValue,
        isAnomaly,
    };
}
async function inspectDownstream(ctx) {
    const deps = ctx.context.topology.dependencies;
    if (!deps.length) {
        return {
            stepType: 'inspect_downstream',
            summary: 'No downstream dependencies found for this service',
            isAnomaly: false,
        };
    }
    const anomalyDeps = [];
    for (const dep of deps) {
        const depSlos = ctx.context.sloStatus.filter((s) => s.serviceId === dep.node.id);
        const hasIssue = depSlos.some((s) => s.status === 'breaching' || s.status === 'at_risk');
        if (hasIssue) {
            anomalyDeps.push(dep.node.name);
        }
    }
    const isAnomaly = anomalyDeps.length > 0;
    return {
        stepType: 'inspect_downstream',
        summary: isAnomaly
            ? `Downstream dependencies with issues: ${anomalyDeps.join(', ')}`
            : `All ${deps.length} downstream dependencies appear healthy`,
        isAnomaly,
        rawData: deps.map((d) => d.node.name),
    };
}
async function correlateDeployments(ctx) {
    const changes = ctx.context.recentChanges;
    if (!changes.length) {
        return {
            stepType: 'correlate_deployments',
            summary: 'No recent changes detected in the lookback window',
            isAnomaly: false,
        };
    }
    const deployments = changes.filter((c) => c.type === 'deploy');
    const recentCutoff = new Date(ctx.intent.timeRange.start).getTime();
    const recentDeploys = deployments.filter((c) => new Date(c.timestamp).getTime() >= recentCutoff);
    const isAnomaly = recentDeploys.length > 0;
    return {
        stepType: 'correlate_deployments',
        summary: isAnomaly
            ? `${recentDeploys.length} deployment(s) found within investigation window (${recentDeploys.map((c) => c.description).join('; ')})`
            : `${changes.length} total changes found; no deploys inside investigation window`,
        isAnomaly,
        rawData: changes.map((c) => ({ id: c.id, type: c.type, timestamp: c.timestamp })),
    };
}
async function sampleTraces(ctx) {
    const { rawData, replayableQuery } = await safeAdapterQueryRaw(ctx, 'trace', 'trace-query');
    if (rawData !== undefined) {
        const traces = rawData;
        const hasErrors = traces?.some((t) => t.status === 'error');
        return {
            stepType: 'sample_traces',
            summary: `${traces.length} trace(s) sampled; ${hasErrors ? 'error traces detected' : 'no errors found'}`,
            isAnomaly: hasErrors,
            rawData: traces,
            replayableQuery,
        };
    }
    return {
        stepType: 'sample_traces',
        summary: 'Trace sampling not yet available via configured adapters - skipped',
        isAnomaly: false,
    };
}
async function clusterLogs(ctx) {
    const { rawData, replayableQuery } = await safeAdapterQueryRaw(ctx, 'log_clusters', 'log-query');
    if (rawData !== undefined) {
        const result = rawData;
        const clusters = result?.clusters ?? [];
        const errorClusters = clusters.filter((c) => c.level === 'error' || c.level === 'fatal');
        const isAnomaly = errorClusters.length > 0;
        return {
            stepType: 'cluster_logs',
            summary: `${clusters.length} log cluster(s) found; ${errorClusters.length} error/fatal cluster(s)`,
            isAnomaly,
            rawData: clusters,
            replayableQuery,
        };
    }
    return {
        stepType: 'cluster_logs',
        summary: 'Log clustering not yet available via configured adapters - skipped',
        isAnomaly: false,
    };
}
async function checkSaturation(ctx) {
    const cpuresult = await safeAdapterQuery(ctx, 'cpu_usage');
    const memResult = await safeAdapterQuery(ctx, 'memory_usage');
    const cpuVal = cpuresult.value;
    const memVal = memResult.value;
    const cpuHigh = cpuVal !== undefined && cpuVal > 80;
    const memHigh = memVal !== undefined && memVal > 85;
    const isAnomaly = cpuHigh || memHigh;
    if (cpuVal === undefined && memVal === undefined) {
        const satSlo = ctx.context.sloStatus.find((s) => s.metricName.includes('cpu') ||
            s.metricName.includes('memory') ||
            s.metricName.includes('saturation'));
        const statusAnomaly = satSlo?.status === 'breaching' || satSlo?.status === 'at_risk';
        return {
            stepType: 'check_saturation',
            summary: satSlo
                ? `Resource saturation SLO (${satSlo.metricName}): ${satSlo.currentValue ?? 'N/A'}`
                : 'No resource saturation data available',
            value: satSlo?.currentValue,
            isAnomaly: satSlo ? statusAnomaly : false,
        };
    }
    const parts = [];
    if (cpuVal !== undefined) {
        parts.push(`CPU: ${cpuVal.toFixed(1)}% ${cpuHigh ? '(HIGH)' : ''}`.trim());
    }
    if (memVal !== undefined) {
        parts.push(`Memory: ${memVal.toFixed(1)}% ${memHigh ? '(HIGH)' : ''}`.trim());
    }
    return {
        stepType: 'check_saturation',
        summary: isAnomaly
            ? `Resource saturation detected: ${parts.join(', ')}`
            : `Resources within normal range: ${parts.join(', ')}`,
        value: cpuVal ?? memVal,
        isAnomaly,
        replayableQuery: cpuresult.replayableQuery ?? memResult.replayableQuery,
    };
}
async function checkTrafficPattern(ctx) {
    const { value: rps, replayableQuery } = await safeAdapterQuery(ctx, 'request_rate');
    if (rps !== undefined) {
        const trafficSlo = ctx.context.sloStatus.find((s) => s.metricName.includes('traffic') || s.metricName.includes('request_rate'));
        const baseline = trafficSlo?.threshold ?? rps;
        const ratio = baseline > 0 ? rps / baseline : 0;
        const isAnomaly = ratio >= 1.3 || ratio <= 0.7;
        return {
            stepType: 'check_traffic_pattern',
            summary: isAnomaly
                ? ratio > 1
                    ? `Traffic surge detected: ${rps.toFixed(1)} rps (${((ratio - 1) * 100).toFixed(0)}% of baseline)`
                    : `Traffic drop detected: ${rps.toFixed(1)} rps (${((1 - ratio) * 100).toFixed(0)}% off baseline)`
                : `Traffic within normal range (${rps.toFixed(1)} rps)`,
            value: rps,
            baseline,
            deviationRatio: ratio - 1,
            isAnomaly,
            replayableQuery,
        };
    }
    return {
        stepType: 'check_traffic_pattern',
        summary: 'No traffic data available from configured adapters',
        isAnomaly: false,
    };
}
function isErrorRateMetric(metricName) {
    const lower = metricName.toLowerCase();
    return (lower.includes('error_rate') ||
        lower.includes('error.rate') ||
        lower.includes('availability') ||
        lower.includes('success_rate'));
}
async function checkSloBurnRate(ctx) {
    const breachingSLos = ctx.context.sloStatus.filter((s) => s.status === 'breaching');
    const atRiskSLos = ctx.context.sloStatus.filter((s) => s.status === 'at_risk');
    if (breachingSLos.length === 0 && atRiskSLos.length === 0) {
        return {
            stepType: 'check_slo_burn_rate',
            summary: 'All SLOs within budget - no burn rate concerns',
            isAnomaly: false,
        };
    }
    const details = [...breachingSLos, ...atRiskSLos].map((s) => {
        const current = s.currentValue ?? 0;
        const threshold = s.threshold ?? 1;
        const errorBudget = isErrorRateMetric(s.metricName) && threshold > 0 ? current / threshold : null;
        return {
            metric: s.metricName,
            service: s.serviceId,
            burnRate: errorBudget,
            status: s.status,
            currentValue: current,
        };
    });
    const burnRates = details.map((d) => d.burnRate).filter((b) => b != null);
    const burnRateNum = burnRates.length > 0 ? Math.max(...burnRates) : null;
    const isAnomaly = breachingSLos.length > 0;
    const burnSummary = burnRateNum
        ? `max burn rate ${burnRateNum.toFixed(1)}x error budget`
        : 'burn rate N/A (non-error-rate SLO)';
    return {
        stepType: 'check_slo_burn_rate',
        summary: `${breachingSLos.length} SLO(s) breaching, ${atRiskSLos.length} at risk. ${burnSummary}`,
        isAnomaly,
        rawData: details,
    };
}
async function checkErrorDistribution(ctx) {
    const deps = ctx.context.topology.dependencies;
    const errorDeps = [];
    for (const dep of deps) {
        const depErrors = ctx.context.sloStatus.filter((s) => s.serviceId === dep.node.id);
        if (depErrors.length > 0 &&
            depErrors.some((s) => s.metricName.includes('error') && (s.status === 'breaching' || s.status === 'at_risk'))) {
            errorDeps.push(dep.node.name);
        }
    }
    const mainError = ctx.context.sloStatus.find((s) => s.metricName.includes('error') && s.status === 'breaching');
    const isAnomaly = errorDeps.length > 0 || mainError !== undefined;
    if (errorDeps.length > 0) {
        return {
            stepType: 'check_error_distribution',
            summary: `Errors concentrated in downstream: ${errorDeps.join(', ')} - likely propagating upstream`,
            isAnomaly,
            rawData: { errorDeps, mainServiceBreaching: mainError !== undefined },
        };
    }
    return {
        stepType: 'check_error_distribution',
        summary: mainError
            ? 'Errors originating from the service itself - not downstream propagation'
            : 'No significant error concentration detected',
        isAnomaly,
    };
}
const STEP_EXECUTORS = {
    compare_latency_vs_baseline: compareLatencyVsBaseline,
    check_error_rate: checkErrorRate,
    inspect_downstream: inspectDownstream,
    correlate_deployments: correlateDeployments,
    sample_traces: sampleTraces,
    cluster_logs: clusterLogs,
    check_saturation: checkSaturation,
    check_traffic_pattern: checkTrafficPattern,
    check_slo_burn_rate: checkSloBurnRate,
    check_error_distribution: checkErrorDistribution,
};
export function getStepsForTaskType(taskType) {
    switch (taskType) {
        case 'explain_latency':
        case 'compare_baseline':
            return [
                'compare_latency_vs_baseline',
                'check_error_rate',
                'check_saturation',
                'inspect_downstream',
                'correlate_deployments',
                'sample_traces',
            ];
        case 'explain_errors':
            return [
                'check_error_rate',
                'check_error_distribution',
                'inspect_downstream',
                'correlate_deployments',
                'check_saturation',
                'cluster_logs',
            ];
        case 'investigate_change':
            return [
                'correlate_deployments',
                'compare_latency_vs_baseline',
                'check_error_rate',
                'check_saturation',
                'inspect_downstream',
            ];
        case 'check_health':
            return [
                'compare_latency_vs_baseline',
                'check_error_rate',
                'check_saturation',
                'check_slo_burn_rate',
                'inspect_downstream',
                'check_traffic_pattern',
            ];
        default:
            return [
                'compare_latency_vs_baseline',
                'check_error_rate',
                'check_saturation',
                'inspect_downstream',
                'correlate_deployments',
                'check_traffic_pattern',
            ];
    }
}
export async function executeStep(stepType, ctx) {
    const executor = STEP_EXECUTORS[stepType];
    return executor(ctx);
}
//# sourceMappingURL=steps.js.map
