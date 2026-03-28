// In-memory trace store - assembles spans into Trace objects and supports
// structured queries with optional sampling and truncation.

const DEFAULT_MAX_SPANS = 1_000;
const DEFAULT_MAX_TRACES = 10_000;

export class TraceStore {
  traces = new Map();
  insertOrder = [];
  maxSpansPerTrace;
  maxTraces;

  constructor(config = {}) {
    this.maxSpansPerTrace = config.maxSpansPerTrace ?? DEFAULT_MAX_SPANS;
    this.maxTraces = config.maxTraces ?? DEFAULT_MAX_TRACES;
  }

  // --- Ingestion ---

  /** Ingest a batch of spans, assembling (or updating) the corresponding Trace. */
  addSpans(spans) {
    // Group by traceId
    const byTrace = new Map();
    for (const span of spans) {
      const list = byTrace.get(span.traceId) ?? [];
      list.push(span);
      byTrace.set(span.traceId, list);
    }

    for (const [traceId, newSpans] of byTrace) {
      const existing = this.traces.get(traceId);
      const merged = existing ? [...existing.spans, ...newSpans] : newSpans;
      this.upsertTrace(traceId, merged);
    }
  }

  /** Directly ingest a fully assembled Trace object. */
  addTrace(trace) {
    if (!this.traces.has(trace.traceId)) {
      this.insertOrder.push(trace.traceId);
    }
    this.traces.set(trace.traceId, trace);
    this.evict();
  }

  // --- Query ---

  getTrace(traceId) {
    return this.traces.get(traceId);
  }

  query(q) {
    if (q.traceId) {
      const t = this.traces.get(q.traceId);
      return t ? [t] : [];
    }

    let results = [];
    for (const trace of this.traces.values()) {
      if (!this.matchesQuery(trace, q)) {
        continue;
      }
      results.push(trace);
    }

    // Sort by startTime descending (newest first)
    results.sort((a, b) => b.startTime.localeCompare(a.startTime));

    // Apply sampling before limit
    const rate = q.samplingRate ?? 1.0;
    if (rate < 1.0) {
      results = results.filter(() => Math.random() < rate);
    }

    if (q.limit !== undefined) {
      results = results.slice(0, q.limit);
    }

    return results;
  }

  // --- Waterfall ---

  buildWaterfall(traceId) {
    const trace = this.traces.get(traceId);
    if (!trace) return null;

    // Pre-build parent -> children index so buildNode is O(1) per span instead of O(n).
    const childrenByParent = new Map();
    for (const span of trace.spans) {
      if (span.parentSpanId !== undefined) {
        const list = childrenByParent.get(span.parentSpanId) ?? [];
        list.push(span);
        childrenByParent.set(span.parentSpanId, list);
      }
    }

    const rootStart = new Date(trace.rootSpan.startTime).getTime();
    return this.buildNode(trace.rootSpan, childrenByParent, 0, rootStart);
  }

  // --- Stats ---

  get size() {
    return this.traces.size;
  }

  clear() {
    this.traces.clear();
    this.insertOrder.length = 0;
  }

  // --- Private helpers ---

  upsertTrace(traceId, spans) {
    const truncated = spans.length > this.maxSpansPerTrace;
    const limited = truncated ? spans.slice(0, this.maxSpansPerTrace) : spans;
    const root = limited.find((s) => !s.parentSpanId) ?? limited[0];

    // Derive trace end from the latest span completion
    const endMs = Math.max(...limited.map((s) => new Date(s.startTime).getTime() + s.durationMs));
    const startMs = new Date(root.startTime).getTime();

    const trace = {
      traceId,
      rootSpan: root,
      spans: limited.sort((a, b) => a.startTime.localeCompare(b.startTime)),
      totalDurationMs: endMs - startMs,
      service: root.service,
      operation: root.operation,
      startTime: root.startTime,
      status: this.deriveStatus(limited),
      truncated,
    };

    if (!this.traces.has(traceId)) {
      this.insertOrder.push(traceId);
    }
    this.traces.set(traceId, trace);
    this.evict();
  }

  deriveStatus(spans) {
    if (spans.some((s) => s.status === 'error')) return 'error';
    if (spans.some((s) => s.status === 'ok')) return 'ok';
    return 'unset';
  }

  matchesQuery(trace, q) {
    const traceStart = new Date(trace.startTime);
    if (q.startTime && traceStart < q.startTime) return false;
    if (q.endTime && traceStart > q.endTime) return false;

    if (q.service && trace.service !== q.service) return false;
    if (q.operation && trace.operation !== q.operation) return false;
    if (q.status && trace.status !== q.status) return false;

    if (q.minDurationMs !== undefined && trace.totalDurationMs < q.minDurationMs) return false;
    if (q.maxDurationMs !== undefined && trace.totalDurationMs > q.maxDurationMs) return false;

    if (q.tags) {
      for (const [k, v] of Object.entries(q.tags)) {
        if (trace.rootSpan.tags[k] !== v) return false;
      }
    }
    return true;
  }

  buildNode(span, childrenByParent, depth, rootStartMs) {
    const childSpans = childrenByParent.get(span.spanId) ?? [];
    const children = childSpans.map((child) => this.buildNode(child, childrenByParent, depth + 1, rootStartMs));

    return {
      span,
      children,
      depth,
      relativeStartMs: new Date(span.startTime).getTime() - rootStartMs,
    };
  }

  evict() {
    while (this.traces.size > this.maxTraces && this.insertOrder.length > 0) {
      const oldest = this.insertOrder.shift();
      this.traces.delete(oldest);
    }
  }
}