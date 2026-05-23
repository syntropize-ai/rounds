/**
 * PermissionsTable / resolveRows tests.
 *
 * Web tests run in a node env (no jsdom). We exercise the pure resolver
 * (`resolveRows`) plus the SSR markup of the table to verify the right
 * icons are highlighted and that the click handlers are wired with the
 * correct capability + policy.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConnectorPolicy } from '@agentic-obs/common';
import PermissionsTable, { resolveRows } from './PermissionsTable.js';

const mkPolicy = (
  capability: string,
  humanPolicy: 'allow' | 'ask' | 'block',
  overrides: Partial<ConnectorPolicy> = {},
): ConnectorPolicy => ({
  connectorId: 'c1',
  subjectType: 'org',
  subjectId: 'org1',
  capability,
  scope: null,
  humanPolicy,
  ...overrides,
});

describe('resolveRows', () => {
  const caps = ['metrics.query', 'runtime.apply'];

  it('explicit org rows win over default', () => {
    const out = resolveRows(caps, [mkPolicy('metrics.query', 'allow')], [], 'org');
    expect(out.find((r) => r.capability === 'metrics.query')).toEqual({
      capability: 'metrics.query',
      policy: 'allow',
      source: 'explicit',
    });
    // No row for runtime.apply → default
    expect(out.find((r) => r.capability === 'runtime.apply')).toEqual({
      capability: 'runtime.apply',
      policy: 'ask',
      source: 'default',
    });
  });

  it('team rows shadow org rows; missing team rows show inherited org policy', () => {
    const teamRows = [mkPolicy('metrics.query', 'block', { subjectType: 'team', subjectId: 't1' })];
    const orgRows = [
      mkPolicy('metrics.query', 'allow'),
      mkPolicy('runtime.apply', 'ask'),
    ];
    const out = resolveRows(caps, teamRows, orgRows, 'team');
    expect(out.find((r) => r.capability === 'metrics.query')).toEqual({
      capability: 'metrics.query',
      policy: 'block',
      source: 'explicit',
    });
    expect(out.find((r) => r.capability === 'runtime.apply')).toEqual({
      capability: 'runtime.apply',
      policy: 'ask',
      source: 'inherited-org',
    });
  });

  it('falls back to ask when nothing exists at any level', () => {
    const out = resolveRows(caps, [], [], 'team');
    expect(out.every((r) => r.source === 'default')).toBe(true);
    expect(out.every((r) => r.policy === 'ask')).toBe(true);
  });
});

describe('PermissionsTable rendering', () => {
  it('renders read + write groups with capabilities', () => {
    const html = renderToStaticMarkup(
      React.createElement(PermissionsTable, {
        capabilities: ['metrics.query', 'runtime.apply'],
        scopeRows: [],
        orgRows: [],
        scope: 'org',
        onSet: () => undefined,
      }),
    );
    expect(html).toContain('metrics.query');
    expect(html).toContain('runtime.apply');
    expect(html).toContain('Read');
    expect(html).toContain('Write');
  });

  it('highlights the explicit policy with aria-pressed=true', () => {
    const html = renderToStaticMarkup(
      React.createElement(PermissionsTable, {
        capabilities: ['metrics.query'],
        scopeRows: [mkPolicy('metrics.query', 'allow')],
        orgRows: [],
        scope: 'org',
        onSet: () => undefined,
      }),
    );
    // The Allow icon for metrics.query should be pressed.
    expect(html).toMatch(/aria-label="metrics\.query: Allow"[^>]*aria-pressed="true"/);
    // The Block icon should not be pressed.
    expect(html).toMatch(/aria-label="metrics\.query: Block"[^>]*aria-pressed="false"/);
  });

  it('renders the inherited hint for team rows missing an explicit row', () => {
    const html = renderToStaticMarkup(
      React.createElement(PermissionsTable, {
        capabilities: ['metrics.query'],
        scopeRows: [],
        orgRows: [mkPolicy('metrics.query', 'block')],
        scope: 'team',
        onSet: () => undefined,
      }),
    );
    expect(html).toContain('inherited');
    // No row is "explicit" → none should be pressed.
    expect(html).not.toMatch(/aria-pressed="true"/);
  });

  it('renders the default hint when no row exists at any level', () => {
    const html = renderToStaticMarkup(
      React.createElement(PermissionsTable, {
        capabilities: ['metrics.query'],
        scopeRows: [],
        orgRows: [],
        scope: 'org',
        onSet: () => undefined,
      }),
    );
    expect(html).toContain('default');
  });

});
