/**
 * PendingChangesBar tests (helpers + first-render markup).
 *
 * Web package uses vitest's node environment (no jsdom). Behaviour after
 * hook state changes isn't observable; we exercise pure helpers and the
 * initial server-rendered HTML.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PendingChangesBar, {
  allChangeIds,
  toggleSelection,
} from '../PendingChangesBar.js';

const sampleChanges = [
  {
    id: 'pc-1',
    proposedAt: '2026-05-08T10:00:00Z',
    proposedBy: 'agent',
    summary: 'Remove panel cpu-usage',
  },
  {
    id: 'pc-2',
    proposedAt: '2026-05-08T10:00:01Z',
    proposedBy: 'agent',
    summary: 'Modify panel latency-p99',
  },
];

describe('allChangeIds', () => {
  it('extracts ids in order', () => {
    expect(allChangeIds(sampleChanges)).toEqual(['pc-1', 'pc-2']);
  });
  it('handles empty input', () => {
    expect(allChangeIds([])).toEqual([]);
  });
});

describe('toggleSelection', () => {
  it('adds an id when not present', () => {
    const next = toggleSelection(new Set(), 'pc-1');
    expect(next.has('pc-1')).toBe(true);
  });
  it('removes an id when already present', () => {
    const next = toggleSelection(new Set(['pc-1']), 'pc-1');
    expect(next.has('pc-1')).toBe(false);
  });
  it('does not mutate the input set', () => {
    const before = new Set(['pc-1']);
    toggleSelection(before, 'pc-2');
    expect(before.size).toBe(1);
  });
});

describe('PendingChangesBar render', () => {
  it('renders nothing when there are no pending changes', () => {
    const html = renderToStaticMarkup(
      <PendingChangesBar
        changes={[]}
        onAccept={() => {}}
        onDiscard={() => {}}
      />,
    );
    expect(html).toBe('');
  });

  it('renders count + Accept all / Reject all / Hide buttons', () => {
    const html = renderToStaticMarkup(
      <PendingChangesBar
        changes={sampleChanges}
        onAccept={() => {}}
        onDiscard={() => {}}
      />,
    );
    expect(html).toContain('2 pending changes');
    expect(html).toContain('Accept all');
    expect(html).toContain('Reject all');
    expect(html).toContain('Hide');
  });

  it('singular wording when there is exactly one change', () => {
    const html = renderToStaticMarkup(
      <PendingChangesBar
        changes={[sampleChanges[0]!]}
        onAccept={() => {}}
        onDiscard={() => {}}
      />,
    );
    expect(html).toContain('1 pending change');
    expect(html).not.toContain('1 pending changes');
  });
});
