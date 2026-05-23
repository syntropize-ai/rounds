import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ScopeSelector from './ScopeSelector.js';

describe('ScopeSelector', () => {
  it('renders org as the default checked radio', () => {
    const html = renderToStaticMarkup(
      React.createElement(ScopeSelector, {
        scope: { kind: 'org' },
        onChange: () => undefined,
        teams: [{ id: 't1', name: 'Platform' }],
      }),
    );
    expect(html).toContain('Organization');
    expect(html).toContain('Team');
    // Org radio is checked.
    expect(html).toMatch(/<input[^>]*type="radio"[^>]*checked/);
    // Team picker not visible when scope=org.
    expect(html).not.toContain('Platform');
  });

  it('reveals the team picker when scope is team', () => {
    const html = renderToStaticMarkup(
      React.createElement(ScopeSelector, {
        scope: { kind: 'team', teamId: 't1' },
        onChange: () => undefined,
        teams: [
          { id: 't1', name: 'Platform' },
          { id: 't2', name: 'SRE' },
        ],
      }),
    );
    expect(html).toContain('Platform');
    expect(html).toContain('SRE');
  });

  it('disables the team option when there are no teams', () => {
    const html = renderToStaticMarkup(
      React.createElement(ScopeSelector, {
        scope: { kind: 'org' },
        onChange: () => undefined,
        teams: [],
        teamsLoading: false,
      }),
    );
    expect(html).toContain('No teams in this org yet.');
  });
});
