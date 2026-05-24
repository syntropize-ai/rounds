/**
 * Tests for the dashboard verify-gate that wraps dashboard_add_panels.
 *
 * Covers:
 *   - gate ON rejects panels whose queries return 0 series (preview-error)
 *   - gate ON accepts clean panels (preview ok + no lint errors)
 *   - gate OFF accepts dirty panels but logs the issues at WARN
 *   - report formatting includes both preview and lint issues
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isVerifyGateEnabled,
  runDashboardVerifyGate,
  formatVerifyReport,
} from '../verify-gate.js';
import { makeFakeActionContext } from '../_test-helpers.js';
import { AdapterRegistry } from '../../../adapters/registry.js';

function makeAdapters(rangeQuery: ReturnType<typeof vi.fn>): AdapterRegistry {
  const reg = new AdapterRegistry();
  reg.register({
    info: { id: 'prom', name: 'prom', type: 'prometheus', signalType: 'metrics' },
    metrics: { rangeQuery } as never,
  });
  return reg;
}

const ONE_SERIES = [
  { metric: { job: 'api' }, values: [[1700000000, '1'], [1700000300, '2']] as Array<[number, string]> },
];

const ENV_KEY = 'DASHBOARD_VERIFY_GATE';
let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env[ENV_KEY];
});
afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
});

describe('isVerifyGateEnabled', () => {
  it('defaults to ON when env is unset', () => {
    delete process.env[ENV_KEY];
    expect(isVerifyGateEnabled()).toBe(true);
  });
  it('returns false only for explicit "0"', () => {
    process.env[ENV_KEY] = '0';
    expect(isVerifyGateEnabled()).toBe(false);
    process.env[ENV_KEY] = '1';
    expect(isVerifyGateEnabled()).toBe(true);
  });
});

describe('runDashboardVerifyGate', () => {
  it('passes with a warning when queries return 0 series (pre-deploy is legit)', async () => {
    const rangeQuery = vi.fn().mockResolvedValue([]);
    const ctx = makeFakeActionContext({
      adapters: makeAdapters(rangeQuery),
      allConnectors: [{ id: 'prom', type: 'prometheus' } as never],
    });
    const report = await runDashboardVerifyGate(ctx, {
      panels: [
        // Description must satisfy dashboard-has-questions to isolate the
        // 0-series behavior under test.
        { title: 'P1', description: 'Q: present?', visualization: 'time_series', queries: [{ expr: 'missing_metric' }] },
      ],
    });
    expect(report.ok).toBe(true);
    expect(report.previewIssues.some((i) => i.severity === 'warn' && i.message.includes('0 series'))).toBe(true);
    expect(report.previewIssues.some((i) => i.severity === 'error')).toBe(false);
  });

  it('passes when every panel previews cleanly', async () => {
    const rangeQuery = vi.fn().mockResolvedValue(ONE_SERIES);
    const ctx = makeFakeActionContext({
      adapters: makeAdapters(rangeQuery),
      allConnectors: [{ id: 'prom', type: 'prometheus' } as never],
    });
    const report = await runDashboardVerifyGate(ctx, {
      panels: [
        { title: 'OK', description: 'Q: is rate ok?', visualization: 'time_series', queries: [{ expr: 'sum(rate(x[5m]))' }] },
      ],
    });
    expect(report.ok).toBe(true);
    expect(report.previewIssues).toHaveLength(0);
    // Lint may emit info-severity skips for rules whose probes aren't mocked
    // (panel-returns-data etc.). The gate only blocks on error-severity.
    expect(report.lintIssues.every((i) => i.severity !== 'error')).toBe(true);
  });

  it('skips preview gracefully when no metrics connector is configured (header rows / pre-deploy)', async () => {
    const rangeQuery = vi.fn();
    const ctx = makeFakeActionContext({
      adapters: makeAdapters(rangeQuery),
      allConnectors: [], // none
    });
    const report = await runDashboardVerifyGate(ctx, {
      panels: [{ title: 'P', description: 'Q: is up?', visualization: 'time_series', queries: [{ expr: 'up' }] }],
    });
    expect(report.ok).toBe(true);
    expect(rangeQuery).not.toHaveBeenCalled();
  });

  it('skips panels with no queries (header / text rows) without flagging them', async () => {
    const rangeQuery = vi.fn().mockResolvedValue(ONE_SERIES);
    const ctx = makeFakeActionContext({
      adapters: makeAdapters(rangeQuery),
      allConnectors: [{ id: 'prom', type: 'prometheus' } as never],
    });
    const report = await runDashboardVerifyGate(ctx, {
      panels: [{ title: 'Header', description: 'Q: section header?', visualization: 'stat', queries: [] }],
    });
    expect(report.ok).toBe(true);
    expect(report.previewIssues).toHaveLength(0);
  });
});

describe('runDashboardVerifyGate — real lint integration', () => {
  it('rejects when a panel violates the `dashboard-has-questions` rule (error severity)', async () => {
    // Panel description does NOT start with "Q: ..." → error.
    const rangeQuery = vi.fn().mockResolvedValue(ONE_SERIES);
    const ctx = makeFakeActionContext({
      adapters: makeAdapters(rangeQuery),
      allConnectors: [{ id: 'prom', type: 'prometheus' } as never],
    });
    const report = await runDashboardVerifyGate(ctx, {
      panels: [
        {
          title: 'unquestioned',
          description: 'just a description',
          visualization: 'time_series',
          queries: [{ expr: 'sum(rate(x[5m]))' }],
        },
      ],
    });
    expect(report.ok).toBe(false);
    const errs = report.lintIssues.filter((i) => i.severity === 'error');
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((i) => i.code === 'dashboard-has-questions')).toBe(true);
  });

  it('does NOT reject when only `viz-matches-data` (info severity) fires', async () => {
    // stat visualization + rate() query → viz-matches-data info issue but
    // no errors. Save must still be ok.
    const rangeQuery = vi.fn().mockResolvedValue(ONE_SERIES);
    const ctx = makeFakeActionContext({
      adapters: makeAdapters(rangeQuery),
      allConnectors: [{ id: 'prom', type: 'prometheus' } as never],
    });
    const report = await runDashboardVerifyGate(ctx, {
      panels: [
        {
          title: 'misviz',
          description: 'Q: how fast?',
          visualization: 'stat',
          queries: [{ expr: 'rate(http_requests_total[5m])' }],
        },
      ],
    });
    expect(report.ok).toBe(true);
    expect(report.lintIssues.every((i) => i.severity !== 'error')).toBe(true);
  });
});

describe('formatVerifyReport', () => {
  it('renders both preview and lint sections', () => {
    const out = formatVerifyReport({
      ok: false,
      previewIssues: [
        { panelIndex: 0, panelTitle: 'X', severity: 'error', message: 'no data', fixHint: 'check labels' },
      ],
      lintIssues: [
        { severity: 'warn', message: 'missing description', panelId: 'p1' },
      ],
    });
    expect(out).toContain('panel_preview issues');
    expect(out).toContain('no data');
    expect(out).toContain('check labels');
    expect(out).toContain('dashboard_lint issues');
    expect(out).toContain('missing description');
  });
});

// ---------------------------------------------------------------------------
// Integration: gate ON vs gate OFF behavior through dashboard_add_panels
// ---------------------------------------------------------------------------
import { handleDashboardAddPanels } from '../dashboard.js';

describe('dashboard_add_panels — verify-gate integration', () => {
  function buildCtx(rangeQuery: ReturnType<typeof vi.fn>) {
    const ctx = makeFakeActionContext({
      adapters: makeAdapters(rangeQuery),
      allConnectors: [{ id: 'prom', type: 'prometheus' } as never],
      activeDashboardId: 'dash-1',
      freshlyCreatedDashboards: new Set(['dash-1']),
    });
    // Pretend the agent already did research + validated the query string,
    // so the dashboard_add_panels evidence pre-checks pass and we exercise
    // the verify-gate proper (not the evidence guard).
    ctx.dashboardBuildEvidence.webSearchCount = 1;
    ctx.dashboardBuildEvidence.validatedQueries.add('sum(rate(x[5m]))');
    ctx.dashboardBuildEvidence.validatedQueries.add('missing_metric');
    return ctx;
  }

  it('gate ON: rejects the save when verify finds errors (real lint error)', async () => {
    process.env[ENV_KEY] = '1';
    // Empty result is now a WARN (pre-deploy is legitimate), so to test the
    // reject path we trigger a real lint error: panel description missing the
    // mandatory "Q: ..." prefix triggers `dashboard-has-questions` (error).
    const rangeQuery = vi.fn().mockResolvedValue(ONE_SERIES);
    const ctx = buildCtx(rangeQuery);
    const out = await handleDashboardAddPanels(ctx, {
      panels: [{ title: 'P', description: 'no question prefix', visualization: 'time_series', queries: [{ expr: 'sum(rate(x[5m]))', datasourceId: 'prom' }] }],
    });
    expect(out).toContain('rejected by verify-gate');
    expect((ctx.actionExecutor.execute as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('gate ON: accepts the save when queries return 0 series (pre-deployment is legitimate)', async () => {
    process.env[ENV_KEY] = '1';
    const rangeQuery = vi.fn().mockResolvedValue([]); // empty
    const ctx = buildCtx(rangeQuery);
    const out = await handleDashboardAddPanels(ctx, {
      panels: [{ title: 'P', description: 'Q: present?', visualization: 'time_series', queries: [{ expr: 'missing_metric', datasourceId: 'prom' }] }],
    });
    expect(out).toContain('Added 1 panel');
    expect((ctx.actionExecutor.execute as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('gate ON: accepts the save when verify is clean', async () => {
    process.env[ENV_KEY] = '1';
    const rangeQuery = vi.fn().mockResolvedValue(ONE_SERIES);
    const ctx = buildCtx(rangeQuery);
    const out = await handleDashboardAddPanels(ctx, {
      panels: [{ title: 'P', description: 'Q: rate?', visualization: 'time_series', queries: [{ expr: 'sum(rate(x[5m]))', datasourceId: 'prom' }] }],
    });
    expect(out).toContain('Added 1 panel');
    expect((ctx.actionExecutor.execute as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('gate OFF: accepts the save even when verify finds errors (logs at WARN)', async () => {
    process.env[ENV_KEY] = '0';
    // Use the dashboard-has-questions error to exercise the bypass path
    // (empty results no longer error since pre-deploy is legit).
    const rangeQuery = vi.fn().mockResolvedValue(ONE_SERIES);
    const ctx = buildCtx(rangeQuery);
    const out = await handleDashboardAddPanels(ctx, {
      panels: [{ title: 'P', description: 'no question prefix', visualization: 'time_series', queries: [{ expr: 'sum(rate(x[5m]))', datasourceId: 'prom' }] }],
    });
    expect(out).toContain('Added 1 panel');
    expect((ctx.actionExecutor.execute as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});
