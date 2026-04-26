// Types are structurally compatible with ILogsAdapter from @agentic-obs/agent-core.
// We avoid importing from agent-core directly to prevent a circular package dependency.

import { getErrorMessage } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';

const log = createLogger('loki-logs-adapter');

export interface LogEntry {
  timestamp: string; // ISO-8601
  message: string;
  labels: Record<string, string>;
}

export interface LogsQueryInput {
  query: string; // LogQL
  start: Date;
  end: Date;
  limit?: number; // default 100
}

export interface LogsQueryResult {
  entries: LogEntry[];
  partial: boolean;
  warnings?: string[];
}

interface LokiStream {
  stream: Record<string, string>;
  values: Array<[string, string]>; // [nanoseconds-as-string, message]
}

interface LokiQueryRangeResponse {
  status?: string;
  data?: {
    resultType?: string;
    result?: LokiStream[] | unknown[];
    stats?: unknown;
  };
  warnings?: string[];
}

interface LokiListResponse {
  status?: string;
  data?: string[];
}

const DEFAULT_LIMIT = 100;

export class LokiLogsAdapter {
  constructor(
    private baseUrl: string,
    private headers: Record<string, string> = {},
    private timeoutMs = 15_000,
  ) {}

  async query(input: LogsQueryInput): Promise<LogsQueryResult> {
    const limit = input.limit ?? DEFAULT_LIMIT;
    const params = new URLSearchParams();
    params.set('query', input.query);
    params.set('start', String(toNanoseconds(input.start)));
    params.set('end', String(toNanoseconds(input.end)));
    params.set('limit', String(limit));
    params.set('direction', 'backward');

    const url = `${this.base}/loki/api/v1/query_range?${params}`;
    let res: Response;
    try {
      res = await this.fetch(url);
    } catch (err) {
      throw new Error(`Loki query_range request failed: ${getErrorMessage(err)}`);
    }

    if (!res.ok) {
      const preview = await readBodyPreview(res);
      throw new Error(
        `Loki returned HTTP ${res.status} for query_range: ${preview}`,
      );
    }

    const body = (await res.json()) as LokiQueryRangeResponse;
    const resultType = body.data?.resultType ?? 'streams';
    const warnings: string[] = Array.isArray(body.warnings) ? [...body.warnings] : [];

    if (resultType !== 'streams') {
      // Matrix result types come from metric-style LogQL (rate, count_over_time, etc).
      // We only flatten "streams"; surface a warning for anything else so callers can
      // re-query or render differently, rather than silently dropping data.
      warnings.push(
        `Unsupported Loki resultType "${resultType}"; LokiLogsAdapter only flattens "streams".`,
      );
      return {
        entries: [],
        partial: true,
        warnings,
      };
    }

    const rawResult = body.data?.result;
    const streams = (Array.isArray(rawResult) ? rawResult : []) as LokiStream[];
    const entries: LogEntry[] = [];
    for (const s of streams) {
      const labels = s.stream ?? {};
      const values = Array.isArray(s.values) ? s.values : [];
      for (const v of values) {
        if (!Array.isArray(v) || v.length < 2) continue;
        const [ns, message] = v;
        entries.push({
          timestamp: nsToIso(ns),
          message: typeof message === 'string' ? message : String(message ?? ''),
          labels: { ...labels },
        });
      }
    }

    // Loki sort order is per-stream. Re-sort globally so callers (and humans eyeballing
    // the feed) get a monotonic timeline across streams. "backward" direction ⇒ desc.
    entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

    const partial = entries.length >= limit;
    const result: LogsQueryResult = { entries, partial };
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  }

  async listLabels(): Promise<string[]> {
    const url = `${this.base}/loki/api/v1/labels`;
    let res: Response;
    try {
      res = await this.fetch(url);
    } catch (err) {
      throw new Error(`Loki labels request failed: ${getErrorMessage(err)}`);
    }
    if (!res.ok) {
      const preview = await readBodyPreview(res);
      throw new Error(`Loki returned HTTP ${res.status} fetching labels: ${preview}`);
    }
    const body = (await res.json()) as LokiListResponse;
    return Array.isArray(body.data) ? body.data : [];
  }

  async listLabelValues(label: string): Promise<string[]> {
    const url = `${this.base}/loki/api/v1/label/${encodeURIComponent(label)}/values`;
    let res: Response;
    try {
      res = await this.fetch(url);
    } catch (err) {
      throw new Error(`Loki label values request failed: ${getErrorMessage(err)}`);
    }
    if (!res.ok) {
      const preview = await readBodyPreview(res);
      throw new Error(
        `Loki returned HTTP ${res.status} fetching label values for "${label}": ${preview}`,
      );
    }
    const body = (await res.json()) as LokiListResponse;
    return Array.isArray(body.data) ? body.data : [];
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await this.fetch(`${this.base}/ready`, 5_000);
      if (res.status !== 200) {
        log.warn(
          { baseUrl: this.base, status: res.status },
          'loki health check returned non-200',
        );
        return false;
      }
      const text = await res.text();
      return text.toLowerCase().includes('ready');
    } catch (err) {
      // isHealthy is documented to return a bool, so we don't throw here —
      // but we DO log the error class so operators can distinguish "Loki down"
      // (ECONNREFUSED) from "DNS broken" (ENOTFOUND) from "TLS misconfig" etc.
      const errClass = err instanceof Error ? err.constructor.name : typeof err;
      const errCode = err instanceof Error ? (err as Error & { code?: string }).code : undefined;
      log.warn(
        { err, errClass, errCode, baseUrl: this.base },
        'loki health check failed',
      );
      return false;
    }
  }

  private get base(): string {
    return this.baseUrl.replace(/\/$/, '');
  }

  private fetch(url: string, timeoutMs?: number): Promise<Response> {
    return fetch(url, {
      headers: this.headers,
      signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
    });
  }
}

function toNanoseconds(d: Date): bigint {
  // Date has millisecond precision; Loki requires ns. Multiply in BigInt so
  // we can render the 19-digit integer without float precision loss.
  return BigInt(d.getTime()) * 1_000_000n;
}

function nsToIso(ns: string | number): string {
  // Values come back as strings (19-digit ns). Truncate to ms for JS Date.
  if (typeof ns === 'number') {
    return new Date(Math.floor(ns / 1_000_000)).toISOString();
  }
  if (typeof ns === 'string' && /^\d+$/.test(ns)) {
    const big = BigInt(ns);
    const ms = Number(big / 1_000_000n);
    return new Date(ms).toISOString();
  }
  // Fallback — let Date parse it and surface "Invalid Date" rather than crash.
  const d = new Date(ns as string);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

async function readBodyPreview(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 200);
  } catch {
    return '<no body>';
  }
}
