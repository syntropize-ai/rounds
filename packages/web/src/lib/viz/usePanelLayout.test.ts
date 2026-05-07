/**
 * Unit tests for decideLegendLayout — the pure decision function that
 * encodes every legend / sizing breakpoint in one place.
 *
 * The hook itself (`usePanelLayout`) is a ~10-line ResizeObserver
 * wrapper around `setSize`; we don't unit-test it because (a) the repo
 * doesn't pull in `@testing-library/react` and (b) the only logic in
 * the hook beyond bookkeeping is the size→sizeClass projection, which
 * is exercised here by feeding the projection's outputs into
 * `decideLegendLayout`.
 */

import { describe, it, expect } from 'vitest';
import { decideLegendLayout, type PanelLayout } from './usePanelLayout.js';

function makeLayout(over: Partial<PanelLayout>): PanelLayout {
  return {
    width: 800,
    height: 300,
    sizeClass: 'wide',
    tooltipMaxWidth: 320,
    ...over,
  };
}

describe('decideLegendLayout — narrow', () => {
  it('forces stacked mode regardless of series count', () => {
    const layout = makeLayout({ width: 250, sizeClass: 'narrow' });
    const d = decideLegendLayout(layout, 1, 1, 'list');
    expect(d.mode).toBe('stacked');
  });

  it('still hides when height < 180 even on narrow', () => {
    const layout = makeLayout({ width: 250, height: 120, sizeClass: 'narrow' });
    const d = decideLegendLayout(layout, 1, 1, 'list');
    expect(d.mode).toBe('hidden');
  });

  it('respects requested=hidden over stacked', () => {
    const layout = makeLayout({ width: 250, sizeClass: 'narrow' });
    const d = decideLegendLayout(layout, 5, 2, 'hidden');
    expect(d.mode).toBe('hidden');
  });
});

describe('decideLegendLayout — medium', () => {
  it('returns list mode with basis 140', () => {
    const layout = makeLayout({ width: 400, sizeClass: 'medium' });
    const d = decideLegendLayout(layout, 1, 1, 'list');
    expect(d.mode).toBe('list');
    expect(d.itemBasis).toBe(140);
  });

  it('upgrades to table when multi-series × multi-stat would crowd a row', () => {
    const layout = makeLayout({ width: 400, sizeClass: 'medium' });
    const d = decideLegendLayout(layout, 3, 3, 'list');
    expect(d.mode).toBe('table');
  });

  it('upgrades to table when more than 6 series', () => {
    const layout = makeLayout({ width: 400, sizeClass: 'medium' });
    const d = decideLegendLayout(layout, 8, 1, 'list');
    expect(d.mode).toBe('table');
  });
});

describe('decideLegendLayout — wide', () => {
  it('returns list mode with basis 220', () => {
    const layout = makeLayout({ width: 800, sizeClass: 'wide' });
    const d = decideLegendLayout(layout, 1, 1, 'list');
    expect(d.mode).toBe('list');
    expect(d.itemBasis).toBe(220);
  });

  it('honors requested=table even on wide with few series', () => {
    const layout = makeLayout({ width: 800, sizeClass: 'wide' });
    const d = decideLegendLayout(layout, 1, 1, 'table');
    expect(d.mode).toBe('table');
  });

  it('upgrades to table on multi-series × multi-stat regardless of width', () => {
    const layout = makeLayout({ width: 800, sizeClass: 'wide' });
    const d = decideLegendLayout(layout, 4, 4, 'list');
    expect(d.mode).toBe('table');
  });
});

describe('decideLegendLayout — degenerate inputs', () => {
  it('returns hidden for zero series', () => {
    const layout = makeLayout({ width: 800 });
    const d = decideLegendLayout(layout, 0, 0, 'list');
    expect(d.mode).toBe('hidden');
  });

  it('itemBasis is 0 in non-list modes', () => {
    const narrow = makeLayout({ width: 250, sizeClass: 'narrow' });
    expect(decideLegendLayout(narrow, 1, 1, 'list').itemBasis).toBe(0);
    const tableForceHigh = makeLayout({ width: 800 });
    expect(decideLegendLayout(tableForceHigh, 8, 2, 'list').itemBasis).toBe(0);
  });

  it('treats height=0 (pre-measurement) as "not too short" — show legend', () => {
    // Initial render, ResizeObserver hasn't fired yet → height: 0. We
    // shouldn't blanket-hide the legend; the gate is height > 0 && height < 180.
    const layout = makeLayout({ width: 800, height: 0 });
    const d = decideLegendLayout(layout, 1, 1, 'list');
    expect(d.mode).toBe('list');
  });
});
