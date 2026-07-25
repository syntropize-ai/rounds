/**
 * A failed admin list fetch must not also render an empty state. Every `load()`
 * in these tabs only calls `setError(...)` on failure and leaves the list at
 * `[]`, so an ungated `items.length === 0 && <EmptyState/>` puts "No teams yet."
 * directly underneath the red ErrorBanner — the failure reads as "nothing here".
 *
 * The web package has no jsdom, so the tabs themselves can't be mounted with an
 * error in state (`useEffect` never runs under renderToStaticMarkup). The gate
 * is therefore asserted two ways:
 *   1. `EmptyState` is unconditional on its own — SSR proof that the gating has
 *      to live at the call site.
 *   2. Each list call site carries the `!error &&` gate.
 */

import React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ErrorBanner, EmptyState } from '../_ui.js';

const read = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');

describe('_ui primitives', () => {
  it('EmptyState renders its label unconditionally, so call sites must gate it', () => {
    const banner = renderToStaticMarkup(<ErrorBanner message="Failed to load teams" />);
    const empty = renderToStaticMarkup(<EmptyState label="No teams yet." />);
    expect(banner).toContain('Failed to load teams');
    expect(empty).toContain('No teams yet.');
  });
});

describe('admin list empty states are gated on !error', () => {
  const cases: Array<[string, string]> = [
    ['Teams.tsx', '{!error && items.length === 0 && <EmptyState label="No teams yet." />}'],
    [
      'ServiceAccounts.tsx',
      '{!error && items.length === 0 && <EmptyState label="No service accounts yet." />}',
    ],
    [
      'Users.tsx',
      '{!error && rows.length === 0 && <EmptyState label="No users match your filters." />}',
    ],
    [
      'Orgs.tsx',
      '{!error && items.length === 0 && <EmptyState label="No organizations match your filters." />}',
    ],
    ['Roles.tsx', '{!error && filtered.length === 0 && <EmptyState label={`No ${bucket} roles.`} />}'],
    [
      'AuditLog.tsx',
      '{!error && items.length === 0 && <EmptyState label="No audit entries match your filters." />}',
    ],
    [
      'OrgUsers.tsx',
      '{!error && rows.length === 0 && <EmptyState label="No members match your filters." />}',
    ],
  ];

  it.each(cases)('%s gates its list empty state', (file, expected) => {
    expect(read(file)).toContain(expected);
  });

  it.each(cases)('%s has an ErrorBanner to show instead', (file) => {
    expect(read(file)).toContain('<ErrorBanner message={error} />');
  });

  // The drawer sub-lists load the same way (catch → setError, list stays [])
  // and sit under the same ErrorBanner.
  const drawerCases: Array<[string, string]> = [
    ['Teams.tsx', '{!error && members.length === 0 && <EmptyState label="No members yet." />}'],
    ['Teams.tsx', '{!error && assigned.length === 0 && <EmptyState label="No roles assigned." />}'],
    ['Roles.tsx', '{!error && perms.length === 0 && <EmptyState label="No permissions." />}'],
    ['Roles.tsx', '{!error && assignments.length === 0 ? ('],
    ['ServiceAccounts.tsx', ') : !error && tokens.length === 0 ? ('],
  ];

  it.each(drawerCases)('%s gates its drawer empty state (%s)', (file, expected) => {
    expect(read(file)).toContain(expected);
  });

  it('leaves permission-denied empty states ungated', () => {
    // These are not load failures — `error` is null and the list is genuinely
    // unavailable to this user, so the empty state is the correct render.
    expect(read('Teams.tsx')).toContain(
      `return <EmptyState label="You don't have permission to view teams." />;`,
    );
    expect(read('ServiceAccounts.tsx')).toContain(
      `return <EmptyState label="You don't have permission to view service accounts." />;`,
    );
  });
});
