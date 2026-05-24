/**
 * ChangeProposalCard tests — exercises the `derivedDiffBullets` helper and
 * the first-render markup for each status. The Web package uses vitest with
 * `environment: 'node'`, so we lean on `renderToStaticMarkup` for the markup
 * tests rather than full DOM behaviour.
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import ChangeProposalCard, { derivedDiffBullets } from '../ChangeProposalCard.js';

describe('derivedDiffBullets', () => {
  it('emits bullets only for changed modify_panel fields', () => {
    const before = {
      title: 'Old',
      visualization: 'time_series',
      queries: [{ expr: 'rate(x[1m])', legendFormat: 'a' }],
      unit: 's',
    };
    const after = {
      title: 'Old', // unchanged
      visualization: 'bar', // changed
      queries: [{ expr: 'rate(y[1m])', legendFormat: 'a' }], // expr changed
      unit: 's', // unchanged
    };
    const bullets = derivedDiffBullets('modify_panel', before, after);
    // visualization + query — 2 bullets, title/unit/legendFormat omitted
    expect(bullets).toHaveLength(2);
    expect(bullets[0]).toContain('visualization');
    expect(bullets[1]).toContain('query');
  });

  it('describes add_panel with title + viz + truncated query', () => {
    const after = {
      title: 'CPU',
      visualization: 'time_series',
      queries: [{ expr: 'a'.repeat(120) }],
    };
    const bullets = derivedDiffBullets('add_panel', null, after);
    expect(bullets[0]).toBe('Panel: CPU');
    expect(bullets[1]).toBe('Visualization: time_series');
    expect(bullets[2]).toMatch(/^Query: a+…$/);
    expect(bullets[2]!.length).toBeLessThanOrEqual(80);
  });

  it('describes remove_panel with the title from beforeJson', () => {
    const before = { title: 'Gone' };
    const bullets = derivedDiffBullets('remove_panel', before, null);
    expect(bullets).toEqual(['Removed panel: Gone']);
  });

  it('describes set_title with both title and description deltas', () => {
    const before = { title: 'A', description: 'x' };
    const after = { title: 'B', description: 'y' };
    const bullets = derivedDiffBullets('set_title', before, after);
    expect(bullets).toHaveLength(2);
    expect(bullets[0]).toContain('Title');
    expect(bullets[1]).toContain('Description');
  });

  it('describes add_variable with name + default', () => {
    const bullets = derivedDiffBullets('add_variable', null, {
      name: 'datasource',
      defaultValue: 'prom',
    });
    expect(bullets).toEqual(['Variable: datasource (default: prom)']);
  });
});

describe('ChangeProposalCard render', () => {
  const baseProps = {
    proposalId: 'p1',
    dashboardId: 'd1',
    panelId: null,
    changeKind: 'set_title' as const,
    summary: 'Rename dashboard',
    beforeJson: { title: 'Old' },
    afterJson: { title: 'New' },
  };

  it('renders Apply/Cancel buttons in pending state', () => {
    const html = renderToStaticMarkup(
      <ChangeProposalCard {...baseProps} initialStatus="pending" />,
    );
    expect(html).toContain('change-proposal-apply-p1');
    expect(html).toContain('change-proposal-cancel-p1');
    expect(html).toContain('Pending your approval');
  });

  it('omits Apply/Cancel in accepted state and shows the header', () => {
    const html = renderToStaticMarkup(
      <ChangeProposalCard {...baseProps} initialStatus="accepted" resolvedAt="2026-05-17T09:00:00Z" />,
    );
    expect(html).not.toContain('change-proposal-apply-p1');
    expect(html).toContain('Applied');
  });

  it('renders rejected state with muted opacity', () => {
    const html = renderToStaticMarkup(
      <ChangeProposalCard {...baseProps} initialStatus="rejected" />,
    );
    expect(html).toContain('Cancelled');
    expect(html).toMatch(/opacity-\d/);
  });

  it('renders expired state with TTL subtitle', () => {
    const html = renderToStaticMarkup(
      <ChangeProposalCard {...baseProps} initialStatus="expired" />,
    );
    expect(html).toContain('Expired');
    expect(html).toContain('自动清理');
  });

  it('controlledStatus overrides initialStatus for chat-history replay', () => {
    const html = renderToStaticMarkup(
      <ChangeProposalCard {...baseProps} initialStatus="pending" controlledStatus="accepted" />,
    );
    expect(html).toContain('Applied');
    expect(html).not.toContain('change-proposal-apply-p1');
  });
});
