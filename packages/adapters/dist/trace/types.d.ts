export type SpanStatus = 'ok' | 'error' | 'unset';

export interface SpanEvent {
  /** ISO-8601 timestamp */
  timestamp: string;
  name: string;
  attributes?: Record<string, string>;
}

export interface Span {
  traceId: string;
  spanId: string;
  /** Absent for root spans */
  parentSpanId?: string;
  service: string;
  operation: string;
  /** ISO-8601 start time */
  startTime: string;
  durationMs: number;
  tags: Record<string, string>;
  events: SpanEvent[];
  status: SpanStatus;
}

export interface Trace {
  traceId: string;
  /** The root span (parentSpanId absent) */
  rootSpan: Span;
  /** All spans including root, sorted by startTime */
  spans: Span[];
  /** Wall-clock duration of the entire trace */
  totalDurationMs: number;
  /** Root service name */
  service: string;
  /** Root operation name */
  operation: string;
  /** Root span start time (ISO-8601) */
  startTime: string;
  status: SpanStatus;
  /** Indicates spans were truncated to stay within maxSpansPerTrace */
  truncated: boolean;
}

export interface WaterfallNode {
  span: Span;
  children: WaterfallNode[];
  /** Nesting depth from root (root = 0) */
  depth: number;
  /** Offset from root span start in milliseconds */
  relativeStartMs: number;
}

export interface TraceQuery {
  service?: string;
  operation?: string;
  traceId?: string;
  minDurationMs?: number;
  maxDurationMs?: number;
  /** Match traces that have ALL of these tags */
  tags?: Record<string, string>;
  status?: SpanStatus;
  startTime?: Date;
  endTime?: Date;
  limit?: number;
  /** Fraction of matching traces to return, 0..1 (default 1.0 = no sampling) */
  samplingRate?: number;
}