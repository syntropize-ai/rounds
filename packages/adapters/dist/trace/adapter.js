import { TraceStore } from './store.js';

// Metric constants
/** Query this metric to get a list of matching Trace objects */
export const METRIC_TRACES = 'traces';
/** Query this metric with filters.traceId to get a WaterfallNode tree */
export const METRIC_TRACE_WATERFALL = 'trace_waterfall';
/** Query to get p95 duration (ms) as a single-point TimeSeries */
export const METRIC_TRACE_P95_DURATION = 'trace_p95_duration';
/** Query to get error rate (0..1) as a single-point TimeSeries */
export const METRIC_TRACE_ERROR_RATE = 'trace_error_rate';

// --- Adapter ---
export class TraceAdapter {
  name;
  description = 'In-memory trace adapter (Tempo / Jaeger / OTEL compatible)';
  store;

  constructor(config = {}) {
    this.name = config.name ?? 'trace';
    this.store = new TraceStore({
      maxSpansPerTrace: config.maxSpansPerTrace,
      maxTraces: config.maxTraces,
    });
  }

  // --- DataAdapter ---
  meta() {
    return {
      supportedMetrics: [
        METRIC_TRACES,
        METRIC_TRACE_WATERFALL,
        METRIC_TRACE_P95_DURATION,
        METRIC_TRACE_ERROR_RATE,
      ],
      timeGranularity: '1s',
      dimensions: [
        { name: 'service', description: 'Root service name' },
        { name: 'operation', description: 'Root operation name' },
        { name: 'status', description: 'Trace status: ok | error | unset' },
        { name: 'traceId', description: 'Exact trace ID for waterfall queries' },
        { name: 'minDuration', description: 'Minimum trace duration filter (ms)' },
        { name: 'maxDuration', description: 'Maximum trace duration filter (ms)' },
        { name: 'samplingRate', description: 'Sampling rate 0..1 (default 1.0)' },
      ],
      supportedSignalTypes: ['traces'],
      supportsStreaming: true,
      supportsHistoricalQuery: true,
      maxLookbackSeconds: 7 * 24 * 3600, // 7 days
    };
  }

  async query(semanticQuery) {
    const start = Date.now();
    const { entity, metric, timeRange, filters, limit } = semanticQuery;
    let data;
    let queryUsed;

    switch (metric) {
      case METRIC_TRACE_WATERFALL: {
        const traceId = filters?.['traceId'];
        if (typeof traceId !== 'string') {
          throw new Error('trace_waterfall query requires filters.traceId');
        }
        data = this.store.buildWaterfall(traceId) ?? null;
        queryUsed = `waterfall traceId=${traceId}`;
        break;
      }

      case METRIC_TRACE_P95_DURATION: {
        const traces = this.store.query({
          service: entity !== '*' ? entity : undefined,
          operation: filters?.['operation'],
          status: filters?.['status'],
          startTime: timeRange.start,
          endTime: timeRange.end,
        });

        const durations = traces.map((t) => t.totalDurationMs).sort((a, b) => a - b);
        const p95 = durations.length > 0
          ? durations[Math.floor(durations.length * 0.95)] ?? durations[durations.length - 1]
          : 0;
        data = [{ metric: 'trace_p95_duration', value: p95, unit: 'ms', sampleSize: traces.length }];
        queryUsed = `p95_duration service=${entity}`;
        break;
      }

      case METRIC_TRACE_ERROR_RATE: {
        const traces = this.store.query({
          service: entity !== '*' ? entity : undefined,
          startTime: timeRange.start,
          endTime: timeRange.end,
        });

        const errorCount = traces.filter((t) => t.status === 'error').length;
        const rate = traces.length > 0 ? errorCount / traces.length : 0;
        data = [{ metric: 'trace_error_rate', value: rate, unit: 'ratio', sampleSize: traces.length }];
        queryUsed = `error_rate service=${entity}`;
        break;
      }

      default: {
        // Default: return matching Trace list
        const samplingRate = filters?.['samplingRate'] !== undefined
          ? Number(filters['samplingRate'])
          : 1.0;

        const traces = this.store.query({
          service: entity !== '*' ? entity : undefined,
          operation: filters?.['operation'],
          status: filters?.['status'],
          tags: this.extractTagFilters(filters),
          minDurationMs: filters?.['minDuration'] !== undefined ? Number(filters['minDuration']) : undefined,
          maxDurationMs: filters?.['maxDuration'] !== undefined ? Number(filters['maxDuration']) : undefined,
          startTime: timeRange.start,
          endTime: timeRange.end,
          limit,
          samplingRate,
        });

        data = traces;
        queryUsed = `traces service=${entity}` +
          (filters?.['operation'] ? ` operation=${filters['operation']}` : '') +
          ` timeRange=[${timeRange.start.toISOString()},${timeRange.end.toISOString()}]`;
        break;
      }
    }

    return {
      data: data,
      metadata: {
        adapterName: this.name,
        signalType: 'traces',
        executedAt: new Date().toISOString(),
        coveredRange: timeRange,
        partial: false,
      },
      queryUsed,
      cost: { durationMs: Date.now() - start, pointsScanned: this.store.size },
    };
  }

  async *stream(subscription) {
    // Snapshot stream: yield all matching traces as events, then stop.
    const traces = this.store.query({
      service: subscription.entity,
      startTime: new Date(0),
      endTime: new Date(),
    });

    for (const trace of traces) {
      yield {
        timestamp: trace.startTime,
        signalType: 'traces',
        source: this.name,
        payload: trace,
      };
    }
  }

  async healthCheck() {
    return {
      status: 'healthy',
      latencyMs: 0,
      message: `${this.store.size} traces in store`,
      checkedAt: new Date().toISOString(),
    };
  }

  // -- Ingestion --
  ingestSpans(spans) {
    this.store.addSpans(spans);
  }

  ingestTrace(trace) {
    this.store.addTrace(trace);
  }

  getWaterfall(traceId) {
    return this.store.buildWaterfall(traceId);
  }

  get traceStore() {
    return this.store;
  }

  // -- Helpers --
  extractTagFilters(filters) {
    if (!filters) return undefined;
    const reserved = new Set([
      'operation', 'status', 'traceId', 'minDuration', 'maxDuration', 'samplingRate',
    ]);
    const tags = {};
    let hasTag = false;
    for (const [k, v] of Object.entries(filters)) {
      if (!reserved.has(k) && typeof v === 'string') {
        tags[k] = v;
        hasTag = true;
      }
    }
    return hasTag ? tags : undefined;
  }
}