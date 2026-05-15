/**
 * InlineChartMessage tests.
 *
 * vitest runs under `environment: 'node'` (no jsdom) in this package, so
 * we exercise:
 *   1. Pure helpers (`seriesToViz`, `formatRangeLabel`, `deriveTitle`,
 *      `deriveInlineChartId`, `parseInlineChartPayload`).
 *   2. Static SSR snapshots covering empty-state chips, summary line,
 *      header title, and query editor visibility toggle.
 * Live interactions (click, drag-zoom, fetch) require jsdom + a fake
 * apiClient; left out here to keep the test surface in line with the
 * package's existing pattern.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import InlineChartMessage, {
  seriesToViz,
  formatRangeLabel,
  deriveTitle,
} from '../InlineChartMessage.js';
import {
  deriveInlineChartId,
  parseInlineChartPayload,
} from '../../hooks/useDashboardChat.js';
import type { ChartSummary } from '@agentic-obs/common';

describe('seriesToViz', () => {
  it('converts unix-sec values to ms points', () => {
    const out = seriesToViz([
      { metric: { __name__: 'foo' }, values: [[1000, '1.5'], [2000, '2.5']] },
    ]);
    expect(out).toEqual([
      {
        labels: { __name__: 'foo' },
        points: [
          { ts: 1_000_000, value: 1.5 },
          { ts: 2_000_000, value: 2.5 },
        ],
      },
    ]);
  });

  it('drops non-finite samples (NaN, Infinity)', () => {
    const out = seriesToViz([
      { metric: {}, values: [[1, 'NaN'], [2, '1'], [3, '+Inf']] },
    ]);
    expect(out[0]!.points).toEqual([{ ts: 2000, value: 1 }]);
  });
});

describe('formatRangeLabel', () => {
  it('matches known relative spans within a minute', () => {
    const now = Date.now();
    const oneHourAgo = new Date(now - 3600 * 1000).toISOString();
    expect(formatRangeLabel(oneHourAgo, new Date(now).toISOString())).toBe('last 1h');
  });

  it('uses HH:MM range for short non-preset windows', () => {
    const start = '2025-01-01T14:00:00Z';
    const end = '2025-01-01T15:30:00Z';
    // Output depends on local timezone, but should match /\d\d:\d\d-\d\d:\d\d/.
    expect(formatRangeLabel(start, end)).toMatch(/^\d\d:\d\d-\d\d:\d\d$/);
  });

  it('returns empty string for invalid range', () => {
    expect(formatRangeLabel('not-a-date', 'also-not')).toBe('');
  });
});

describe('deriveTitle', () => {
  it('uses __name__ from first series when present', () => {
    const t = deriveTitle('rate(foo[1m])', [{ metric: { __name__: 'http_requests' }, values: [] }], 'counter');
    expect(t).toBe('rate: http_requests');
  });

  it('falls back to query when no __name__', () => {
    const t = deriveTitle('up', [], 'gauge');
    expect(t).toBe('up');
  });

  it('truncates long queries with ellipsis', () => {
    const long = 'sum(rate(http_request_duration_seconds_bucket{job=\"frontend\"}[5m])) by (le)';
    const t = deriveTitle(long, [], 'latency');
    expect(t.length).toBeLessThanOrEqual(61);
    expect(t.endsWith('…')).toBe(true);
  });
});

describe('deriveInlineChartId', () => {
  it('is deterministic for the same inputs', () => {
    const a = deriveInlineChartId('up', 'ds1', '2025-01-01T00:00Z', '2025-01-01T01:00Z');
    const b = deriveInlineChartId('up', 'ds1', '2025-01-01T00:00Z', '2025-01-01T01:00Z');
    expect(a).toBe(b);
  });

  it('differs when any field changes', () => {
    const base = deriveInlineChartId('up', 'ds1', 's', 'e');
    expect(deriveInlineChartId('up', 'ds2', 's', 'e')).not.toBe(base);
    expect(deriveInlineChartId('down', 'ds1', 's', 'e')).not.toBe(base);
  });
});

describe('parseInlineChartPayload', () => {
  const goodPayload = {
    type: 'inline_chart',
    query: 'up',
    datasourceId: 'ds1',
    timeRange: { start: '2025-01-01T00:00Z', end: '2025-01-01T01:00Z' },
    step: '60s',
    metricKind: 'gauge',
    series: [],
    summary: { kind: 'gauge', oneLine: 'avg 1', stats: {} },
    pivotSuggestions: [],
  };

  it('parses a well-formed payload', () => {
    const parsed = parseInlineChartPayload(goodPayload);
    expect(parsed).not.toBeNull();
    expect(parsed!.query).toBe('up');
    expect(parsed!.id).toContain('ds1');
  });

  it('returns null when required fields are missing', () => {
    expect(parseInlineChartPayload({ ...goodPayload, query: '' })).toBeNull();
    expect(parseInlineChartPayload({ ...goodPayload, datasourceId: '' })).toBeNull();
    expect(parseInlineChartPayload({ ...goodPayload, timeRange: {} })).toBeNull();
  });

  it('drops malformed pivot suggestions', () => {
    const parsed = parseInlineChartPayload({
      ...goodPayload,
      pivotSuggestions: [{ id: 'a', label: 'A' }, { id: '', label: 'bad' }, null, { id: 'b' }],
    });
    expect(parsed!.pivotSuggestions).toEqual([{ id: 'a', label: 'A' }]);
  });

  it('falls back to gauge for an unknown metricKind', () => {
    const parsed = parseInlineChartPayload({ ...goodPayload, metricKind: 'wat' });
    expect(parsed!.metricKind).toBe('gauge');
  });
});

const baseProps = {
  id: 'chart:ds1:s:e:up',
  initialQuery: 'up',
  initialTimeRange: { start: '2025-01-01T00:00Z', end: '2025-01-01T01:00Z' },
  initialSeries: [],
  initialSummary: { kind: 'gauge' as const, oneLine: 'avg 1', stats: {} } satisfies ChartSummary,
  metricKind: 'gauge' as const,
  datasourceId: 'prometheus-prod',
};

describe('InlineChartMessage SSR', () => {
  it('renders empty state with Try chips when no series', () => {
    const html = renderToStaticMarkup(React.createElement(InlineChartMessage, baseProps));
    expect(html).toContain('No data in this time range');
    expect(html).toContain('Try 6h');
    expect(html).toContain('Try 24h');
  });

  it('renders the summary one-liner', () => {
    const html = renderToStaticMarkup(React.createElement(InlineChartMessage, {
      ...baseProps,
      initialSummary: { kind: 'latency', oneLine: 'avg 120ms · p95 240ms', stats: {} },
    }));
    expect(html).toContain('avg 120ms · p95 240ms');
  });

  it('renders the derived title in the header', () => {
    const html = renderToStaticMarkup(React.createElement(InlineChartMessage, {
      ...baseProps,
      initialQuery: 'rate(http_requests[1m])',
      initialSeries: [{ metric: { __name__: 'http_requests' }, values: [] }],
      metricKind: 'counter',
    }));
    expect(html).toContain('rate: http_requests');
  });

  it('hides the query editor by default', () => {
    const html = renderToStaticMarkup(React.createElement(InlineChartMessage, baseProps));
    expect(html).not.toContain('data-testid="query-editor"');
  });

  it('renders pivot chips when suggestions are present', () => {
    const html = renderToStaticMarkup(React.createElement(InlineChartMessage, {
      ...baseProps,
      pivotSuggestions: [{ id: 'p1', label: 'by route' }],
    }));
    expect(html).toContain('by route');
  });

  it('renders the datasource id in the editor pill (when expanded — sanity-check the editor markup compiles)', () => {
    // Editor is collapsed by default; we just confirm the component compiles
    // and produces a [▼ Query] toggle.
    const html = renderToStaticMarkup(React.createElement(InlineChartMessage, baseProps));
    expect(html).toContain('Query');
    expect(html).toContain('data-testid="inline-chart-message"');
  });
});
