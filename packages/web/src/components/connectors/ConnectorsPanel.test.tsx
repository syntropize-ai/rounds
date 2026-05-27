/**
 * Happy-path smoke test for ConnectorsPanel.
 *
 * Web tests run in node (no jsdom) so we exercise SSR only — useEffect
 * never runs. We mock `useAuth` to inject a fake user/orgId; the list
 * starts empty (loading=true) which is what initial SSR shows.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../../contexts/AuthContext.js', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'u@example.com', orgId: 'org-1', isServerAdmin: true },
    currentOrg: null,
    orgs: [],
    isServerAdmin: true,
    permissions: {},
    loading: false,
    error: null,
    logoutWarning: null,
    login: () => Promise.resolve(),
    logout: () => Promise.resolve(),
    switchOrg: () => Promise.resolve(),
    hasPermission: () => true,
  }),
}));

import ConnectorsPanel from './ConnectorsPanel.js';

describe('ConnectorsPanel', () => {
  it('renders the list pane + an empty detail pane on initial render', () => {
    const html = renderToStaticMarkup(
      React.createElement(ConnectorsPanel, { canWrite: true }),
    );
    // Middle pane affordances. The compact list shows a single dashed "+ Add"
    // pseudo-row at the end (no top "+ New connector" button anymore).
    expect(html).toContain('aria-label="Add connector"');
    // The detail pane initial state when nothing is selected and loading is true.
    expect(html).toContain('Loading connectors…');
  });

  it('renders the Add button as disabled when canWrite is false', () => {
    const html = renderToStaticMarkup(
      React.createElement(ConnectorsPanel, { canWrite: false }),
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>\s*<span[^>]*>\+/);
  });
});
