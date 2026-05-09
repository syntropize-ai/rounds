/**
 * Zod schemas for API response shapes that we want to validate at the client
 * boundary. Boundary-only — we do NOT zod-ify the entire codebase. The point
 * is to fail loudly when the server drifts out of contract on the
 * highest-value response shapes, instead of letting `as T` casts silently
 * produce undefined-property crashes deeper in the render path.
 *
 * Mirrors `packages/common/src/models/dashboard.ts` (Dashboard, PanelConfig)
 * and `packages/web/src/components/panel/types.ts` (RangeResponse,
 * InstantResponse). Keep these in sync when the canonical types change.
 */
import { z } from 'zod';

// PromQL query response shapes (from /api/query/range and /api/query/instant)

const PrometheusRangeResultSchema = z.object({
  metric: z.record(z.string()),
  values: z.array(z.tuple([z.number(), z.string()])),
});

const PrometheusInstantResultSchema = z.object({
  metric: z.record(z.string()),
  value: z.tuple([z.number(), z.string()]),
});

export const RangeResponseSchema = z.object({
  status: z.string(),
  data: z.object({
    result: z.array(PrometheusRangeResultSchema),
  }),
});

export const InstantResponseSchema = z.object({
  status: z.string(),
  data: z.object({
    result: z.array(PrometheusInstantResultSchema),
  }),
});

// PanelConfig — keep loose: many optional polish fields, agent may emit
// future fields we haven't taught the schema yet. We use .passthrough() so
// unknown keys are preserved for forward compatibility.

const PanelQuerySchema = z.object({
  refId: z.string(),
  expr: z.string(),
  legendFormat: z.string().optional(),
  instant: z.boolean().optional(),
  datasourceId: z.string().optional(),
});

const PanelThresholdSchema = z.object({
  value: z.number(),
  color: z.string(),
  label: z.string().optional(),
});

const PanelAnnotationSchema = z.object({
  time: z.number(),
  label: z.string(),
  color: z.string().optional(),
});

const PanelSnapshotDataSchema = z
  .object({
    range: z
      .array(
        z.object({
          refId: z.string(),
          legendFormat: z.string().optional(),
          series: z.array(
            z.object({
              labels: z.record(z.string()),
              points: z.array(z.object({ ts: z.number(), value: z.number() })),
            }),
          ),
          totalSeries: z.number(),
        }),
      )
      .optional(),
    instant: z
      .object({
        data: z.object({
          result: z.array(
            z.object({
              metric: z.record(z.string()),
              value: z.tuple([z.number(), z.string()]),
            }),
          ),
        }),
      })
      .optional(),
    sparkline: z
      .object({
        timestamps: z.array(z.number()),
        values: z.array(z.number()),
      })
      .optional(),
    capturedAt: z.string(),
  })
  .passthrough();

const PanelVisualizationSchema = z.enum([
  'time_series',
  'stat',
  'table',
  'gauge',
  'bar',
  'bar_gauge',
  'heatmap',
  'pie',
  'histogram',
  'status_timeline',
]);

export const PanelConfigSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    // Description is documented as required on the canonical type, but some
    // legacy/seed dashboards omit it. Accept missing/empty without failing.
    description: z.string().optional(),
    queries: z.array(PanelQuerySchema).optional(),
    visualization: PanelVisualizationSchema,
    row: z.number().optional(),
    col: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    refreshIntervalSec: z.number().nullable().optional(),
    unit: z.string().optional(),
    thresholds: z.array(PanelThresholdSchema).optional(),
    stackMode: z.enum(['none', 'normal', 'percent']).optional(),
    fillOpacity: z.number().optional(),
    decimals: z.number().optional(),
    sparkline: z.boolean().optional(),
    colorMode: z.enum(['value', 'background', 'none']).optional(),
    graphMode: z.enum(['none', 'area']).optional(),
    lineWidth: z.number().optional(),
    showPoints: z.enum(['auto', 'never']).optional(),
    yScale: z.enum(['linear', 'log']).optional(),
    legendStats: z.array(z.enum(['last', 'mean', 'max', 'min'])).optional(),
    legendPlacement: z.enum(['bottom', 'right']).optional(),
    colorScale: z.enum(['linear', 'sqrt', 'log']).optional(),
    collapseEmptyBuckets: z.boolean().optional(),
    barGaugeMax: z.number().optional(),
    barGaugeMode: z.enum(['gradient', 'lcd']).optional(),
    annotations: z.array(PanelAnnotationSchema).optional(),
    query: z.string().optional(),
    sectionId: z.string().optional(),
    sectionLabel: z.string().optional(),
    snapshotData: PanelSnapshotDataSchema.optional(),
  })
  .passthrough();

const DashboardVariableSchema = z
  .object({
    name: z.string(),
    label: z.string(),
    type: z.enum(['query', 'custom', 'datasource']),
    query: z.string().optional(),
    options: z.array(z.string()).optional(),
    current: z.string().optional(),
    multi: z.boolean().optional(),
    includeAll: z.boolean().optional(),
  })
  .passthrough();

export const DashboardSchema = z
  .object({
    id: z.string(),
    type: z.literal('dashboard'),
    title: z.string(),
    // Backend always returns description but it may be empty. Accept optional
    // to keep the frontend tolerant of older rows that predate the schema.
    description: z.string().optional(),
    prompt: z.string().optional(),
    userId: z.string().optional(),
    status: z.enum(['generating', 'ready', 'failed']),
    panels: z.array(PanelConfigSchema),
    // `variables` is occasionally absent on legacy rows; tolerate.
    variables: z.array(DashboardVariableSchema).optional(),
    refreshIntervalSec: z.number().optional(),
    datasourceIds: z.array(z.string()).optional(),
    useExistingMetrics: z.boolean().optional(),
    folder: z.string().optional(),
    workspaceId: z.string().optional(),
    version: z.number().optional(),
    publishStatus: z.enum(['draft', 'published', 'archived']).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    error: z.string().optional(),
    // Task 09 — AI-proposed modifications awaiting user review.
    pendingChanges: z
      .array(
        z
          .object({
            id: z.string(),
            proposedAt: z.string(),
            proposedBy: z.string(),
            sessionId: z.string().optional(),
            summary: z.string(),
            op: z.record(z.unknown()),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

/**
 * Thrown by `apiClient.parseAs()` when a response payload doesn't match the
 * schema for that endpoint. Carries the underlying ZodError on `.cause` so
 * callers can inspect specific path failures during debugging.
 */
export class ApiResponseShapeError extends Error {
  readonly schemaName: string;
  readonly issues: z.ZodIssue[];
  constructor(schemaName: string, issues: z.ZodIssue[]) {
    super(`API response shape mismatch for ${schemaName}`);
    this.name = 'ApiResponseShapeError';
    this.schemaName = schemaName;
    this.issues = issues;
  }
}

/**
 * Validate a payload against a schema; throw `ApiResponseShapeError` and log
 * the validation issues on failure. Returns the parsed payload (possibly
 * transformed by the schema, e.g. defaults filled in).
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, schemaName: string, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    console.error(`[api] response shape mismatch for ${schemaName}:`, result.error.issues);
    throw new ApiResponseShapeError(schemaName, result.error.issues);
  }
  return result.data;
}

// Convenience aliases — callers import these instead of the raw schemas so
// the call site reads `validateDashboard(data)` rather than carrying the
// schema name string everywhere.
export const validateDashboard = (data: unknown) =>
  parseOrThrow(DashboardSchema, 'Dashboard', data);
export const validatePanelConfig = (data: unknown) =>
  parseOrThrow(PanelConfigSchema, 'PanelConfig', data);
export const validateRangeResponse = (data: unknown) =>
  parseOrThrow(RangeResponseSchema, 'RangeResponse', data);
export const validateInstantResponse = (data: unknown) =>
  parseOrThrow(InstantResponseSchema, 'InstantResponse', data);
