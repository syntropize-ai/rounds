/**
 * Pure-render tests for AlertRuleEdit's preview pane. The web package does
 * not pull in jsdom, so we use renderToStaticMarkup (same pattern as
 * AskUserPrompt.test.tsx) to assert markup for each preview state without
 * touching the network or the parent form's effects.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreviewPane, type PreviewState } from './AlertRuleEdit.js';

function render(state: PreviewState, threshold = 0.5): string {
  return renderToStaticMarkup(<PreviewPane state={state} threshold={threshold} />);
}

describe('AlertRuleEdit PreviewPane', () => {
  it('renders nothing in the idle state', () => {
    expect(render({ status: 'idle' })).toBe('');
  });

  it('shows a loading message while backtesting', () => {
    const html = render({ status: 'loading' });
    expect(html).toContain('alert-preview-loading');
    expect(html).toContain('Backtesting');
  });

  it('shows the missing-capability explainer for no_metrics_datasource', () => {
    const html = render({
      status: 'success',
      data: { kind: 'missing_capability', reason: 'no_metrics_datasource' },
    });
    expect(html).toContain('alert-preview-missing');
    expect(html).toContain('no metrics datasource is configured');
  });

  it('shows the no-data explainer when query returns zero series', () => {
    const html = render({
      status: 'success',
      data: { kind: 'ok', wouldHaveFired: 0, sampleTimestamps: [], seriesCount: 0, lookbackHours: 24, reason: 'no_series' },
    });
    expect(html).toContain('alert-preview-no-data');
    expect(html).toContain('No series returned');
  });

  it('shows the firing count and sample timestamps on a happy-path success', () => {
    const html = render({
      status: 'success',
      data: {
        kind: 'ok',
        wouldHaveFired: 3,
        sampleTimestamps: ['2026-05-08T00:00:00.000Z', '2026-05-08T01:00:00.000Z'],
        seriesCount: 2,
        lookbackHours: 24,
      },
    });
    expect(html).toContain('alert-preview-success');
    expect(html).toContain('alert-preview-fired-count');
    expect(html).toContain('Would have fired 3 times');
    expect(html).toContain('2026-05-08T00:00:00.000Z');
  });
});
