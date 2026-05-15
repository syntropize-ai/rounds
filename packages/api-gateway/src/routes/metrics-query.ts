/**
 * POST /api/metrics/query — inline chart bubble's backing endpoint.
 *
 * The frontend chart component (PR-B) calls this when the user asks
 * "what is p50 latency now" in chat: the agent's `metric_explore` tool
 * pushes an `inline_chart` SSE event, the bubble fetches via this route to
 * keep its data fresh on user-pivots (PR-C — re-aggregations, zooms).
 *
 * Auth: requires `connectors:query` permission on the datasource (Rounds'
 * closest analog to "metrics:read" — see packages/common/src/rbac/actions.ts).
 * Rate limit: 240 queries/min per user per datasource (in-memory token bucket).
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  ac,
  ACTIONS,
  AuditAction,
  getErrorMessage,
  summarizeChart,
  type ChartMetricKind,
  type Connector,
} from '@agentic-obs/common';
import { AdapterError, PrometheusMetricsAdapter } from '@agentic-obs/adapters';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { authMiddleware } from '../middleware/auth.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import type { SetupConfigService } from '../services/setup-config-service.js';
import type { AuditWriter } from '../auth/audit-writer.js';

export interface MetricsQueryRouterDeps {
  setupConfig: SetupConfigService;
  ac: AccessControlSurface;
  audit: AuditWriter;
  /**
   * Test seam — defaults to constructing a real `PrometheusMetricsAdapter`
   * from the connector's config. Tests pass a stub so they don't need a live
   * Prometheus.
   */
  buildAdapter?: (connector: Connector) => {
    rangeQuery: PrometheusMetricsAdapter['rangeQuery'];
  };
  /**
   * Test seam — `Date.now()`-style clock so rate-limit tests are deterministic.
   */
  now?: () => number;
}

// -- Rate limit (per user per datasource, in-memory token bucket) ----------
// 240 queries/min — at one every 0.25s this is way past human pacing for
// drag-zoom / chip-switch / chip-pivot bursts, but still catches a runaway
// browser bug or a leaked retry loop. Per-process is fine since the
// surface is "throwaway exploration in chat" and multi-replica setups can
// migrate to the Redis bucket later.
//
// History: initial value was 30/min, which a real user hit in 15s by
// clicking through a few time-range chips. The chart UI is designed for
// fast iteration; the limit must not be felt by humans.

const RATE_LIMIT_PER_MIN = 240;
const RATE_LIMIT_WINDOW_MS = 60_000;

interface BucketEntry {
  windowStart: number;
  count: number;
}
const bucket = new Map<string, BucketEntry>();

function rateLimitKey(userId: string, datasourceId: string): string {
  return `${userId}::${datasourceId}`;
}

/** Returns `null` on allow, or `{ retryAfterSec }` on deny. */
function checkRateLimit(key: string, now: number): { retryAfterSec: number } | null {
  const entry = bucket.get(key);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    bucket.set(key, { windowStart: now, count: 1 });
    return null;
  }
  if (entry.count < RATE_LIMIT_PER_MIN) {
    entry.count += 1;
    return null;
  }
  const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - entry.windowStart);
  return { retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
}

// -- Time range parsing -----------------------------------------------------

const RELATIVE_RANGE_MS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

interface ResolvedRange {
  start: Date;
  end: Date;
}

function resolveTimeRange(
  input: unknown,
  now: () => number,
): ResolvedRange | { error: string } {
  if (!input || typeof input !== 'object') {
    return { error: 'timeRange is required' };
  }
  const r = input as { start?: unknown; end?: unknown; relative?: unknown };
  if (typeof r.relative === 'string') {
    const span = RELATIVE_RANGE_MS[r.relative];
    if (!span) return { error: `unsupported relative range "${r.relative}"` };
    const end = new Date(now());
    const start = new Date(end.getTime() - span);
    return { start, end };
  }
  if (typeof r.start === 'string' && typeof r.end === 'string') {
    const start = new Date(r.start);
    const end = new Date(r.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return { error: 'timeRange.start / timeRange.end must be ISO-8601' };
    }
    if (end.getTime() <= start.getTime()) {
      return { error: 'timeRange.end must be after timeRange.start' };
    }
    return { start, end };
  }
  return { error: 'timeRange must be { start, end } or { relative }' };
}

/** Pick a step targeting ~150 points across the range. Snaps to a fixed set. */
function pickStep(start: Date, end: Date): string {
  const seconds = Math.max(1, Math.floor((end.getTime() - start.getTime()) / 1000));
  const target = Math.floor(seconds / 150);
  const buckets = [15, 30, 60, 5 * 60, 15 * 60, 60 * 60];
  for (const b of buckets) {
    if (target <= b) return `${b}s`;
  }
  return `${buckets[buckets.length - 1]}s`;
}

// -- Datasource resolution + adapter construction --------------------------

function configString(connector: Connector, key: string): string | undefined {
  const value = connector.config[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function defaultBuildAdapter(connector: Connector) {
  const baseUrl = configString(connector, 'url') ?? '';
  const headers: Record<string, string> = {};
  const username = configString(connector, 'username');
  const password = configString(connector, 'password');
  const apiKey = configString(connector, 'apiKey');
  if (username && password) {
    const token = Buffer.from(`${username}:${password}`).toString('base64');
    headers['Authorization'] = `Basic ${token}`;
  } else if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return new PrometheusMetricsAdapter(baseUrl, headers);
}

async function resolvePrometheus(
  setupConfig: SetupConfigService,
  orgId: string,
  datasourceId: string | undefined,
): Promise<Connector | null> {
  if (datasourceId) {
    const c = await setupConfig.getConnector(datasourceId, { orgId });
    if (!c) return null;
    if (c.type !== 'prometheus' && c.type !== 'victoria-metrics') return null;
    return c;
  }
  // No datasource supplied — fall back to the primary (isDefault) metrics
  // connector for the workspace. The dashboard/query router refuses to
  // default; this surface is "throwaway exploration in chat" so defaulting
  // is the right tradeoff.
  const list = await setupConfig.listConnectors({ orgId });
  const metrics = list.filter(
    (c) => c.type === 'prometheus' || c.type === 'victoria-metrics',
  );
  if (metrics.length === 0) return null;
  const primary = metrics.find((c) => c.isDefault) ?? metrics[0];
  return primary ?? null;
}

// -- Heuristic: classify a PromQL expression into a chart kind --------------

export function inferKind(query: string): ChartMetricKind {
  const q = query.toLowerCase();
  if (q.includes('histogram_quantile')) return 'latency';
  if (/_errors?\b|5xx|status=~?"5/.test(q)) return 'errors';
  if (/\brate\s*\(|\bsum\s*\(\s*rate\s*\(/.test(q)) return 'counter';
  return 'gauge';
}

// -- Error mapping ----------------------------------------------------------

function statusForAdapterError(err: AdapterError): number {
  switch (err.kind) {
    case 'bad_request': return 400;
    case 'auth_failure': return 403;
    case 'not_found': return 404;
    case 'rate_limit': return 429;
    case 'timeout':
    case 'server_error':
    case 'connection_refused':
    case 'dns_failure':
    case 'malformed_response':
      return 502;
    default: return 500;
  }
}

function codeForAdapterError(err: AdapterError): string {
  if (err.kind === 'bad_request') return 'BAD_QUERY';
  if (err.kind === 'auth_failure') return 'FORBIDDEN';
  if (err.kind === 'rate_limit') return 'RATE_LIMITED';
  return 'UPSTREAM_ERROR';
}

// -- Router -----------------------------------------------------------------

export function createMetricsQueryRouter(deps: MetricsQueryRouterDeps): Router {
  const router = Router();
  const requirePermission = createRequirePermission(deps.ac);
  const now = deps.now ?? (() => Date.now());
  const buildAdapter = deps.buildAdapter ?? defaultBuildAdapter;

  // Datasource-scoped permission gate. We resolve the datasource first
  // (so the scope passed to ac.eval is the real id, not a placeholder),
  // then check `connectors:query` on it. Resolution failures short-circuit
  // before the permission check.
  router.post(
    '/query',
    authMiddleware,
    async (req: Request, res: Response, next) => {
      const auth = (req as AuthenticatedRequest).auth;
      if (!auth) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'authentication required' } });
        return;
      }
      const body = req.body as {
        query?: unknown;
        datasourceId?: unknown;
        timeRange?: unknown;
        step?: unknown;
        metricKind?: unknown;
      };

      const query = typeof body.query === 'string' ? body.query.trim() : '';
      if (!query) {
        res.status(400).json({ error: { code: 'BAD_QUERY', message: 'query is required' } });
        return;
      }

      const datasourceIdInput = typeof body.datasourceId === 'string' && body.datasourceId.trim()
        ? body.datasourceId.trim()
        : undefined;

      const ds = await resolvePrometheus(deps.setupConfig, auth.orgId, datasourceIdInput);
      if (!ds) {
        res.status(400).json({
          error: {
            code: 'NO_DATASOURCE',
            message: datasourceIdInput
              ? `Datasource "${datasourceIdInput}" not found, not Prometheus-compatible, or not in your org`
              : 'No Prometheus-compatible datasource configured for this workspace',
          },
        });
        return;
      }

      // Datasource-scoped permission check (replaces a static
      // requirePermission middleware — we needed the resolved id first).
      try {
        const evaluator = ac.eval(ACTIONS.ConnectorsQuery, `connectors:uid:${ds.id}`);
        const allowed = await deps.ac.evaluate(auth, evaluator);
        if (!allowed) {
          res.status(403).json({
            error: {
              code: 'FORBIDDEN',
              message: `User has no permission to ${evaluator.string()}`,
            },
          });
          return;
        }
      } catch (err) {
        next(err);
        return;
      }

      const rangeOrErr = resolveTimeRange(body.timeRange, now);
      if ('error' in rangeOrErr) {
        res.status(400).json({ error: { code: 'BAD_QUERY', message: rangeOrErr.error } });
        return;
      }

      // Rate-limit (after permission so we don't leak rate-state across
      // unauthorized callers).
      const limitKey = rateLimitKey(auth.userId, ds.id);
      const limit = checkRateLimit(limitKey, now());
      if (limit) {
        res.status(429).json({
          error: {
            code: 'RATE_LIMITED',
            message: `Rate limit exceeded: ${RATE_LIMIT_PER_MIN}/min per datasource`,
            retryAfterSec: limit.retryAfterSec,
          },
        });
        return;
      }

      const step = typeof body.step === 'string' && body.step.trim()
        ? body.step.trim()
        : pickStep(rangeOrErr.start, rangeOrErr.end);

      const kindInput = typeof body.metricKind === 'string'
        ? body.metricKind as ChartMetricKind
        : inferKind(query);
      const validKinds: ChartMetricKind[] = ['latency', 'counter', 'gauge', 'errors'];
      const kind = (validKinds as string[]).includes(kindInput) ? kindInput : inferKind(query);

      const startedAt = Date.now();
      try {
        const adapter = buildAdapter(ds);
        const series = await adapter.rangeQuery(query, rangeOrErr.start, rangeOrErr.end, step);
        const summary = summarizeChart(series, kind);

        // Audit (fire-and-forget — never block the response).
        void deps.audit.log({
          action: AuditAction.MetricsQuery,
          actorType: 'user',
          actorId: auth.userId,
          targetType: 'connector',
          targetId: ds.id,
          outcome: 'success',
          metadata: {
            orgId: auth.orgId,
            query: query.slice(0, 500),
            step,
            source: 'rest',
          },
        });

        res.json({
          series,
          query,
          timeRange: {
            start: rangeOrErr.start.toISOString(),
            end: rangeOrErr.end.toISOString(),
          },
          summary,
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        if (err instanceof AdapterError) {
          const status = statusForAdapterError(err);
          const code = codeForAdapterError(err);
          res.status(status).json({
            error: {
              code,
              message: err.toUserMessage(),
              ...(code === 'BAD_QUERY' ? { hint: 'check PromQL syntax' } : {}),
            },
          });
          return;
        }
        res.status(500).json({
          error: { code: 'INTERNAL_ERROR', message: getErrorMessage(err) },
        });
      }
    },
  );

  // Reference unused middleware factory so eslint doesn't flag the import
  // when this file is the only consumer of createRequirePermission's other
  // permission patterns. Removed once a future endpoint uses it.
  void requirePermission;

  return router;
}

/** Test-only: clear the in-memory rate-limit bucket between runs. */
export function __resetRateLimitForTests(): void {
  bucket.clear();
}
