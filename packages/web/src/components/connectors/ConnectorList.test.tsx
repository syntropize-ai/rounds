import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ConnectorList from './ConnectorList.js';
import type { ConnectorRow } from './types.js';

const mk = (over: Partial<ConnectorRow>): ConnectorRow => ({
  id: 'c1',
  type: 'prometheus',
  name: 'Prom',
  status: 'draft',
  ...over,
});

describe('ConnectorList', () => {
  it('renders the dashed Add row as the empty-state affordance', () => {
    // The verbose "No connectors yet" hint was removed when the prominent
    // "+ New connector" header button was dropped — the dashed Add row at
    // the end of the list now doubles as the empty-state CTA, with its
    // label switching to "Add your first connector" when the list is empty.
    const html = renderToStaticMarkup(
      React.createElement(ConnectorList, {
        connectors: [],
        selectedId: null,
        onSelect: () => undefined,
        onAddClick: () => undefined,
        canWrite: true,
      }),
    );
    expect(html).toContain('Add your first connector');
    expect(html).toContain('aria-label="Add connector"');
  });

  it('splits Connected vs Not connected by status / verification', () => {
    const html = renderToStaticMarkup(
      React.createElement(ConnectorList, {
        connectors: [
          mk({ id: 'a', name: 'Active Prom', status: 'active' }),
          mk({ id: 'b', name: 'Failed Loki', type: 'loki', status: 'failed' }),
          mk({
            id: 'c',
            name: 'Verified Tempo',
            type: 'tempo',
            status: 'draft',
            lastVerifiedAt: '2026-01-01T00:00:00Z',
          }),
        ],
        selectedId: 'a',
        onSelect: () => undefined,
        onAddClick: () => undefined,
        canWrite: true,
      }),
    );
    expect(html).toContain('Connected');
    expect(html).toContain('Not connected');
    expect(html).toContain('Active Prom');
    expect(html).toContain('Failed Loki');
    expect(html).toContain('Verified Tempo');
    // Selected row carries aria-current="true".
    expect(html).toMatch(/aria-current="true"[^>]*>\s*<span[^>]*>P<\/span>\s*<span[^>]*>Active Prom/);
  });

  it('disables the add button when the user lacks write permission', () => {
    const html = renderToStaticMarkup(
      React.createElement(ConnectorList, {
        connectors: [],
        selectedId: null,
        onSelect: () => undefined,
        onAddClick: () => undefined,
        canWrite: false,
      }),
    );
    // The button is rendered with `disabled`; HTML attribute is bare "disabled".
    expect(html).toMatch(/<button[^>]*disabled[^>]*>\s*<span[^>]*>\+/);
  });
});
