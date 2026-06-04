import { createLogger } from '@agentic-obs/server-utils/logging';
import { AdapterError, classifyHttpError } from '../errors.js';
import type {
  ILogsAdapter,
  LogEntry,
  LogsQueryInput,
  LogsQueryResult,
} from '../interfaces.js';

const log = createLogger('humio-logs-adapter');
const ADAPTER_ID = 'humio';
const DEFAULT_LIMIT = 100;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_MAX_POLLS = 20;

interface HumioQueryCreateResponse {
  id?: string;
}

interface HumioQueryResult {
  done?: boolean;
  cancelled?: boolean;
  events?: Array<Record<string, unknown>>;
  fieldStats?: Array<{
    fieldName?: string;
    topValues?: Array<{ value?: unknown } | unknown>;
  }>;
  warnings?: string[];
}

export class HumioLogsAdapter implements ILogsAdapter {
  constructor(
    private baseUrl: string,
    private repository: string,
    private headers: Record<string, string> = {},
    private timeoutMs = 15_000,
  ) {}

  async query(input: LogsQueryInput): Promise<LogsQueryResult> {
    const limit = input.limit ?? DEFAULT_LIMIT;
    const result = await this.runQuery(input.query, input.start, input.end, {
      limit,
      includeFieldStats: false,
    });
    const events = Array.isArray(result.events) ? result.events.slice(0, limit) : [];
    const entries = events.map(eventToLogEntry).sort((a, b) =>
      a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0,
    );
    return {
      entries,
      partial: result.done !== true || entries.length >= limit,
      ...(Array.isArray(result.warnings) && result.warnings.length > 0
        ? { warnings: result.warnings }
        : {}),
    };
  }

  async listLabels(): Promise<string[]> {
    const result = await this.runQuery('fieldset()', lookbackStart(), new Date(), {
      limit: 200,
      includeFieldStats: false,
    });
    const labels = new Set<string>();
    for (const event of result.events ?? []) {
      for (const key of Object.keys(event)) {
        if (isSystemResultKey(key)) continue;
        labels.add(key);
      }
      for (const value of Object.values(event)) {
        if (typeof value !== 'string') continue;
        for (const part of value.split(/\r?\n/)) {
          const trimmed = part.trim();
          if (trimmed && !isSystemResultKey(trimmed)) labels.add(trimmed);
        }
      }
    }
    return [...labels].sort();
  }

  async listLabelValues(label: string): Promise<string[]> {
    const safeLabel = label.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
    const result = await this.runQuery(`groupBy([\`${safeLabel}\`], limit=200)`, lookbackStart(), new Date(), {
      limit: 200,
      includeFieldStats: false,
    });
    const values = new Set<string>();
    for (const event of result.events ?? []) {
      const value = event[label] ?? event[`@${label}`];
      if (value !== undefined && value !== null) values.add(String(value));
    }
    return [...values].sort();
  }

  async isHealthy(): Promise<boolean> {
    try {
      const result = await this.runQuery('limit(1)', lookbackStart(), new Date(), {
        limit: 1,
        includeFieldStats: false,
        maxPolls: 3,
      });
      return result.cancelled !== true;
    } catch (err) {
      const errClass = err instanceof Error ? err.constructor.name : typeof err;
      log.warn({ err, errClass, baseUrl: this.base, repository: this.repository }, 'humio health check failed');
      return false;
    }
  }

  private async runQuery(
    queryString: string,
    start: Date,
    end: Date,
    opts: {
      limit: number;
      includeFieldStats: boolean;
      maxPolls?: number;
    },
  ): Promise<HumioQueryResult> {
    const createBody = {
      queryString,
      start: start.getTime(),
      end: end.getTime(),
      isLive: false,
      noResultUntilDone: true,
      computeFieldStats: opts.includeFieldStats,
    };
    const create = await this.fetchJson<HumioQueryCreateResponse>(
      `${this.queryJobsUrl}`,
      'createQueryJob',
      {
        method: 'POST',
        body: JSON.stringify(createBody),
      },
    );
    if (!create.id) {
      throw new AdapterError('malformed_response', 'Humio create query job: missing id', {
        adapterId: ADAPTER_ID,
        operation: 'createQueryJob',
      });
    }

    const jobUrl = `${this.queryJobsUrl}/${encodeURIComponent(create.id)}`;
    const maxPolls = opts.maxPolls ?? DEFAULT_MAX_POLLS;
    for (let i = 0; i < maxPolls; i += 1) {
      const result = await this.fetchJson<HumioQueryResult>(jobUrl, 'pollQueryJob');
      if (result.done || result.cancelled) return result;
      await sleep(DEFAULT_POLL_INTERVAL_MS);
    }
    return { done: false, events: [], warnings: ['Humio query did not finish before the polling deadline.'] };
  }

  private async fetchJson<T>(url: string, op: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...this.headers,
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new AdapterError(
        classifyHttpError({ cause: err }),
        `Humio ${op} request failed: ${err instanceof Error ? err.message : String(err)}`,
        { adapterId: ADAPTER_ID, operation: op, originalError: err },
      );
    }
    if (!res.ok) {
      const preview = await readBodyPreview(res);
      throw new AdapterError(
        classifyHttpError({ status: res.status }),
        `Humio returned HTTP ${res.status} for ${op}: ${preview}`,
        { adapterId: ADAPTER_ID, operation: op, status: res.status, upstreamBody: preview },
      );
    }
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new AdapterError('malformed_response', `Humio ${op}: malformed response body`, {
        adapterId: ADAPTER_ID,
        operation: op,
        originalError: err,
      });
    }
  }

  private get base(): string {
    return normalizeHumioBaseUrl(this.baseUrl);
  }

  private get queryJobsUrl(): string {
    return `${this.base}/api/v1/repositories/${encodeURIComponent(this.repository)}/queryjobs`;
  }
}

export function normalizeHumioBaseUrl(raw: string): string {
  return raw
    .replace(/\/+$/, '')
    .replace(/\/api\/v1\/?$/i, '');
}

function eventToLogEntry(event: Record<string, unknown>): LogEntry {
  const timestamp = timestampFromEvent(event);
  const raw =
    event['@rawstring'] ??
    event.message ??
    event.rawstring ??
    JSON.stringify(event);
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === '@rawstring' || key === 'message') continue;
    if (value === undefined || value === null) continue;
    labels[key] = String(value);
  }
  return {
    timestamp,
    message: typeof raw === 'string' ? raw : String(raw),
    labels,
  };
}

function timestampFromEvent(event: Record<string, unknown>): string {
  const raw = event['@timestamp'];
  if (typeof raw === 'number') return new Date(raw).toISOString();
  if (typeof raw === 'string') {
    if (/^\d+$/.test(raw)) return new Date(Number(raw)).toISOString();
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(0).toISOString();
}

function lookbackStart(): Date {
  return new Date(Date.now() - 60 * 60 * 1000);
}

function isSystemResultKey(key: string): boolean {
  return key === '_count' || key === '@timestamp' || key === '@rawstring' || key === 'fields';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBodyPreview(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 200);
  } catch {
    return '<no body>';
  }
}
