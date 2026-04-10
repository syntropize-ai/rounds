import type { LogLine, LogAdapterConfig, LokiQueryResponse, LogLevel } from './types.js';
import { createLogger } from '@agentic-obs/common';
import { escapeLabelValue } from '../utils/escape.js';

const log = createLogger('loki-client');

// -- Client interface --

export interface LogQueryParams {
  entity: string;
  start: Date;
  end: Date;
  filters?: Record<string, string | string[]>;
  limit?: number;
}

export interface ILogClient {
  queryLogs(params: LogQueryParams): Promise<LogLine[]>;
  health(): Promise<boolean>;
}

// -- Level normalisation --

function normaliseLevel(raw: string | undefined): LogLevel {
  switch (raw?.toLowerCase()) {
    case 'trace': return 'trace';
    case 'debug': return 'debug';
    case 'info':
    case 'information': return 'info';
    case 'warn':
    case 'warning': return 'warn';
    case 'error': return 'error';
    case 'fatal':
    case 'critical': return 'fatal';
    default: return 'unknown';
  }
}

// -- Input sanitisation helpers --

const KNOWN_LOG_LEVELS = new Set([
  'trace', 'debug', 'info', 'information',
  'warn', 'warning', 'error', 'fatal', 'critical',
]);

/** Return true only for well-known log-level strings (whitelist). */
function isKnownLogLevel(value: string): boolean {
  return KNOWN_LOG_LEVELS.has(value.toLowerCase());
}

/**
 * Escape all RE2/PCRE metacharacters in a user-supplied pattern so that it
 * is treated as a literal substring search rather than an arbitrary regex.
 * Also escapes '`' because the result is embedded inside a Loki `|~ "..."` filter.
 *
 * Characters escaped: . * + ? ^ $ { } [ ] | ( ) \ "
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&');
}

// -- Loki HTTP client --

export class LokiHttpClient implements ILogClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;

  constructor(config: LogAdapterConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.headers = {
      'Content-Type': 'application/json',
      ...(config.headers ?? {}),
    };
    if (config.auth) {
      const encoded = Buffer.from(`${config.auth.username}:${config.auth.password}`).toString('base64');
      this.headers['Authorization'] = `Basic ${encoded}`;
    }
  }

  async queryLogs(params: LogQueryParams): Promise<LogLine[]> {
    const selector = this.buildSelector(params);
    const url = new URL(`${this.baseUrl}/loki/api/v1/query_range`);
    url.searchParams.set('query', selector);
    url.searchParams.set('start', String(params.start.getTime() * 1_000_000)); // ns
    url.searchParams.set('end', String(params.end.getTime() * 1_000_000));
    url.searchParams.set('limit', String(params.limit ?? 1000));
    url.searchParams.set('direction', 'forward');

    const res = await fetch(url.toString(), {
      headers: this.headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`Loki HTTP ${res.status}: ${res.statusText}`);
    }

    const body = await res.json() as LokiQueryResponse;
    if (body.status === 'error') {
      throw new Error(`Loki query error: ${body.error}`);
    }

    return this.parseStreams(body, params.entity);
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/ready`, {
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch (err) {
      log.debug({ err }, 'failed to check Loki health');
      return false;
    }
  }

  private buildSelector(params: LogQueryParams): string {
    const labels: string[] = [`service="${escapeLabelValue(params.entity)}"`];
    const filters = params.filters ?? {};

    if (filters['namespace']) {
      labels.push(`namespace="${escapeLabelValue(String(filters['namespace']))}"`);
    }
    if (filters['pod']) {
      labels.push(`pod="${escapeLabelValue(String(filters['pod']))}"`);
    }

    let selector = `{${labels.join(',')}}`;

    // Log-level filter - whitelist only known levels to prevent injection
    if (filters['level']) {
      const raw = Array.isArray(filters['level']) ? filters['level'] : [filters['level']];
      const safe = raw.filter(isKnownLogLevel);
      if (safe.length > 0) {
        selector += ` |~ "(?i)(${safe.join('|')})"`;
      }
    }

    // Free-text pattern filter - escape regex metacharacters to prevent injection
    if (filters['pattern']) {
      selector += ` |~ "${escapeRegex(String(filters['pattern']))}"`;
    }

    return selector;
  }

  private parseStreams(body: LokiQueryResponse, entity: string): LogLine[] {
    const lines: LogLine[] = [];
    for (const stream of body.data.result) {
      const labels = stream.stream;
      for (const [tsNs, raw] of stream.values) {
        const tsMs = Number(tsNs) / 1_000_000;
        lines.push({
          timestamp: new Date(tsMs).toISOString(),
          level: normaliseLevel(labels['level'] ?? labels['severity']),
          message: raw,
          service: labels['service'] ?? entity,
          labels,
          traceId: labels['traceID'] ?? labels['trace_id'] ?? undefined,
          spanId: labels['spanID'] ?? labels['span_id'] ?? undefined,
        });
      }
    }
    return lines.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }
}

// -- Mock client (for testing / offline dev) --

export interface MockLogClientOptions {
  lines?: LogLine[];
  shouldFail?: boolean;
  failMessage?: string;
}

export class MockLogClient implements ILogClient {
  private lines: LogLine[];
  private shouldFail: boolean;
  private failMessage: string;

  constructor(options: MockLogClientOptions = {}) {
    this.lines = options.lines ?? [];
    this.shouldFail = options.shouldFail ?? false;
    this.failMessage = options.failMessage ?? 'Mock log client error';
  }

  async queryLogs(params: LogQueryParams): Promise<LogLine[]> {
    if (this.shouldFail) throw new Error(this.failMessage);

    return this.lines.filter((l) => {
      const ts = new Date(l.timestamp).getTime();
      return ts >= params.start.getTime() && ts <= params.end.getTime();
    });
  }

  async health(): Promise<boolean> {
    return !this.shouldFail;
  }

  /** Replace the lines returned by future queries (useful in tests). */
  setLines(lines: LogLine[]): void {
    this.lines = lines;
  }

  setFailing(fail: boolean): void {
    this.shouldFail = fail;
  }
}