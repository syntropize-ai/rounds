/**
 * Pure-render test for MyWorkspace's empty-state copy (Wave 1 / PR-C).
 *
 * Mirrors AlertRuleEdit.test.tsx's renderToStaticMarkup pattern — the web
 * package doesn't bring jsdom, so we don't mount the full page; just the
 * extracted EmptyState helper.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmptyState } from './MyWorkspace.js';

describe('MyWorkspace EmptyState', () => {
  it('renders the empty-workspace prompt with the AI hint', () => {
    const html = renderToStaticMarkup(<EmptyState />);
    expect(html).toContain('workspace-empty');
    expect(html).toContain('Your workspace is empty.');
    expect(html).toContain('Ask AI to create a dashboard or alert');
    expect(html).toContain('temporary explorations land');
  });
});
