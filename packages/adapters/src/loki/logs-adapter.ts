// Concrete Loki implementation of the canonical ILogsAdapter.

import { createLogger } from '@agentic-obs/common/logging';
import { AdapterError, classifyHttpError } from '../errors.js';
import type {
  ILogsAdapter,
  LogEntry,
  LogsQueryInput,
  LogsQueryResult,
} from '../interfaces.js';

const log = createLogger('loki-logs-adapter');

const ADAPTER_ID = 'loki';

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

function transportError(op: string, err: unknown): AdapterError {
  // Internal-facing message preserves legacy wording so existing log-greps
  // and the test suite still match. User-facing strings come from
  // `toUserMessage()` and never include this detail.
  const opLabel = op === 'query' ? 'query_range request' : `${op} request`;
  return new AdapterError(
    classifyHttpError({ cause: err }),
    `Loki ${opLabel} failed: ${err instanceof Error ? err.message : String(err)}`,
    { adapterId: ADAPTER_ID, operation: op, originalError: err },
  );
}

async function httpError(op: string, res: Response): Promise<AdapterError> {
  const preview = await readBodyPreview(res);
  const opLabel = op === 'query' ? 'query_range' : op;
  return new AdapterError(
    classifyHttpError({ status: res.status }),
    `Loki returned HTTP ${res.status} for ${opLabel}: ${preview}`,
    {
      adapterId: ADAPTER_ID,
      operation: op,
      status: res.status,
      upstreamBody: preview,
    },
  );
}

async function parseJson<T>(res: Response, op: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new AdapterError(
      'malformed_response',
      `Loki ${op}: malformed response body`,
      { adapterId: ADAPTER_ID, operation: op, originalError: err },
    );
  }
}

export class LokiLogsAdapter implements ILogsAdapter {
  constructor(
    private baseUrl: string,
    private headers: Record<string, string> = {},
    private timeoutMs = 15_000,
  ) {}

  async query(input: LogsQueryInput): Promise<LogsQueryResult> {
    const op = 'query';
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
      throw transportError(op, err);
    }

    if (!res.ok) {
      throw await httpError(op, res);
    }

    const body = await parseJson<LokiQueryRangeResponse>(res, op);
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
    const op = 'listLabels';
    const url = `${this.base}/loki/api/v1/labels`;
    let res: Response;
    try {
      res = await this.fetch(url);
    } catch (err) {
      throw transportError(op, err);
    }
    if (!res.ok) {
      throw await httpError(op, res);
    }
    const body = await parseJson<LokiListResponse>(res, op);
    return Array.isArray(body.data) ? body.data : [];
  }

  async listLabelValues(label: string): Promise<string[]> {
    const op = 'listLabelValues';
    const url = `${this.base}/loki/api/v1/label/${encodeURIComponent(label)}/values`;
    let res: Response;
    try {
      res = await this.fetch(url);
    } catch (err) {
      throw transportError(op, err);
    }
    if (!res.ok) {
      throw await httpError(op, res);
    }
    const body = await parseJson<LokiListResponse>(res, op);
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
