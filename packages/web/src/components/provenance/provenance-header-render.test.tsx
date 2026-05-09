/**
 * ProvenanceHeader rendering tests.
 *
 * Web tests run vitest under `environment: 'node'` (no jsdom) so we assert
 * via `renderToStaticMarkup` and look for the rendered field labels and
 * values. The header MUST degrade gracefully when fields are missing —
 * cost/latency `null` or `undefined` should render "—" rather than crash.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ProvenanceHeader from './ProvenanceHeader.js';

describe('<ProvenanceHeader />', () => {
  it('renders all fields when fully populated', () => {
    const html = renderToStaticMarkup(
      <ProvenanceHeader
        provenance={{
          model: 'claude-opus-4-7',
          runId: 'inv_a1b2c3d4-e5f6',
          toolCalls: 5,
          evidenceCount: 3,
          costUsd: 0.04,
          latencyMs: 22000,
        }}
        onViewRunLog={() => {}}
      />,
    );
    expect(html).toContain('claude-opus-4-7');
    expect(html).toContain('inv_a1b2');
    expect(html).toContain('>5<');
    expect(html).toContain('>3<');
    expect(html).toContain('$0.04');
    expect(html).toContain('22.0s');
    expect(html).toContain('View run log');
  });

  it('degrades to em dashes when fields are missing — does not crash', () => {
    const html = renderToStaticMarkup(
      <ProvenanceHeader provenance={{}} />,
    );
    // Five "—" placeholders: model, run, tools, evidence, cost, latency = 6.
    const dashCount = (html.match(/—/g) ?? []).length;
    expect(dashCount).toBeGreaterThanOrEqual(5);
    expect(html).not.toContain('View run log');
  });

  it('handles null cost/latency without throwing', () => {
    expect(() =>
      renderToStaticMarkup(
        <ProvenanceHeader
          provenance={{
            model: 'gpt-test',
            costUsd: null as unknown as number,
            latencyMs: null as unknown as number,
          }}
        />,
      ),
    ).not.toThrow();
  });
});
