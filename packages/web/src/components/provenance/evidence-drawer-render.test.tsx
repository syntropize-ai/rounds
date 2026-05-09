/**
 * EvidenceDrawer rendering test.
 *
 * Confirms the drawer renders one row per citation and that the highlighted
 * row carries the marker class the click handler relies on. The
 * `scrollIntoView` side-effect in `useEffect` requires a DOM and is exercised
 * in the integration runtime — this unit test just locks the visual marker.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import EvidenceDrawer from './EvidenceDrawer.js';

const citations = [
  { ref: 'm1', kind: 'metric' as const, summary: 'CPU saturation' },
  { ref: 'l1', kind: 'log' as const, summary: 'OOM kill log' },
];

describe('<EvidenceDrawer />', () => {
  it('renders nothing when closed', () => {
    const html = renderToStaticMarkup(
      <EvidenceDrawer citations={citations} open={false} onClose={() => {}} />,
    );
    expect(html).toBe('');
  });

  it('renders one row per citation when open', () => {
    const html = renderToStaticMarkup(
      <EvidenceDrawer citations={citations} open={true} onClose={() => {}} />,
    );
    expect(html).toContain('CPU saturation');
    expect(html).toContain('OOM kill log');
    expect(html).toContain('data-citation-ref="m1"');
    expect(html).toContain('data-citation-ref="l1"');
  });

  it('marks the highlighted row with the primary ring class', () => {
    const html = renderToStaticMarkup(
      <EvidenceDrawer
        citations={citations}
        open={true}
        highlightedRef="l1"
        onClose={() => {}}
      />,
    );
    // The highlighted row (l1) should have ring; m1 should not.
    const l1Idx = html.indexOf('data-citation-ref="l1"');
    const m1Idx = html.indexOf('data-citation-ref="m1"');
    const l1Slice = html.slice(l1Idx, l1Idx + 200);
    const m1Slice = html.slice(m1Idx, m1Idx + 200);
    expect(l1Slice).toContain('ring-1');
    expect(m1Slice).not.toContain('ring-1');
  });

  it('shows an empty-state message when no citations', () => {
    const html = renderToStaticMarkup(
      <EvidenceDrawer citations={[]} open={true} onClose={() => {}} />,
    );
    expect(html).toContain('No citations');
  });
});
