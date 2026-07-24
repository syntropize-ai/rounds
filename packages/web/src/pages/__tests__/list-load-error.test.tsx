/**
 * A failed list fetch must never render as an empty state — "No alert rules
 * yet" while the backend is erroring reads as "all clear". The web package has
 * no jsdom, so the states are asserted with renderToStaticMarkup (same pattern
 * as AlertRuleEdit.test.tsx).
 */

import React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AlertsListState } from '../Alerts.js';
import { InvestigationsListState } from '../Investigations.js';

const noop = () => undefined;

describe('AlertsListState', () => {
  it('shows the failure and a retry affordance when the fetch failed', () => {
    const html = renderToStaticMarkup(
      <AlertsListState loading={false} loadError="Network request failed" ruleCount={0} onRetry={noop} />,
    );
    expect(html).toContain('alerts-load-error');
    expect(html).toContain('Failed to load alert rules');
    expect(html).toContain('Network request failed');
    expect(html).toContain('Retry');
    expect(html).not.toContain('No alert rules yet');
  });

  it('keeps the failure visible even when stale rules are still on screen', () => {
    const html = renderToStaticMarkup(
      <AlertsListState loading={false} loadError="503 Service Unavailable" ruleCount={4} onRetry={noop} />,
    );
    expect(html).toContain('Failed to load alert rules');
    expect(html).toContain('503 Service Unavailable');
  });

  it('shows the empty state only when the fetch succeeded with no rules', () => {
    const html = renderToStaticMarkup(
      <AlertsListState loading={false} loadError={null} ruleCount={0} onRetry={noop} />,
    );
    expect(html).toContain('No alert rules yet');
    expect(html).not.toContain('Failed to load alert rules');
  });

  it('shows the loading state before the first response', () => {
    const html = renderToStaticMarkup(
      <AlertsListState loading loadError={null} ruleCount={0} onRetry={noop} />,
    );
    expect(html).toContain('animate-spin');
    expect(html).not.toContain('No alert rules yet');
    expect(html).not.toContain('Failed to load alert rules');
  });

  it('renders nothing once rules are loaded', () => {
    expect(
      renderToStaticMarkup(
        <AlertsListState loading={false} loadError={null} ruleCount={2} onRetry={noop} />,
      ),
    ).toBe('');
  });
});

describe('InvestigationsListState', () => {
  it('shows the failure and a retry affordance when the fetch failed', () => {
    const html = renderToStaticMarkup(
      <InvestigationsListState loading={false} loadError="Network request failed" count={0} onRetry={noop} />,
    );
    expect(html).toContain('investigations-load-error');
    expect(html).toContain('Failed to load investigations');
    expect(html).toContain('Network request failed');
    expect(html).toContain('Retry');
    expect(html).not.toContain('No investigations yet');
  });

  it('shows the empty state only when the fetch succeeded with no investigations', () => {
    const html = renderToStaticMarkup(
      <InvestigationsListState loading={false} loadError={null} count={0} onRetry={noop} />,
    );
    expect(html).toContain('No investigations yet');
    expect(html).not.toContain('Failed to load investigations');
  });

  it('shows the loading state before the first response', () => {
    const html = renderToStaticMarkup(
      <InvestigationsListState loading loadError={null} count={0} onRetry={noop} />,
    );
    expect(html).toContain('investigations-loading');
    expect(html).not.toContain('No investigations yet');
    expect(html).not.toContain('Failed to load investigations');
  });

  it('renders nothing once investigations are loaded', () => {
    expect(
      renderToStaticMarkup(
        <InvestigationsListState loading={false} loadError={null} count={3} onRetry={noop} />,
      ),
    ).toBe('');
  });
});

/**
 * Dashboards' backend search had the same shape in a nastier form:
 * `if (!res.error) setSearchResults(res.data.results)` left the PREVIOUS
 * term's hits in state on failure, so the page rendered either those stale
 * rows or `No results for "<new term>"`. Dashboards can't be mounted here
 * (router hooks, and useEffect never runs under renderToStaticMarkup), so the
 * fix is asserted at the source, as in admin/list-empty-state-gate.test.tsx.
 */
describe('Dashboards search failures', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../Dashboards.tsx', import.meta.url)),
    'utf8',
  );

  it('does not swallow a failed search', () => {
    expect(src).not.toContain('if (!res.error) setSearchResults(res.data.results);');
  });

  it('drops the previous term\'s hits and records the failure', () => {
    expect(src).toMatch(
      /if \(res\.error\) \{[\s\S]*?setSearchResults\(\[\]\);[\s\S]*?setSearchError\(res\.error\.message\);[\s\S]*?\}/,
    );
  });

  it('gates the "No results" empty state on there being no error', () => {
    expect(src).toContain('{!searching && !searchError && searchResults.length === 0 && (');
  });

  it('shows the failure with the page\'s existing text-error style', () => {
    expect(src).toContain('<p className="text-sm text-error mb-2">Failed to search</p>');
  });
});
