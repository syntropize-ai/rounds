import { describe, it, expect } from 'vitest';
import type { ConnectorPolicy } from '@agentic-obs/common';
import {
  applyOptimistic,
  applyReset,
  buildBatchBodies,
  buildUpsertBody,
} from './permissions-actions.js';

const ctx = { connectorId: 'c1', subjectType: 'team' as const, subjectId: 't9' };

describe('buildUpsertBody', () => {
  it('builds the PUT body for a single capability', () => {
    expect(buildUpsertBody(ctx, 'metrics.query', 'allow')).toEqual({
      subjectType: 'team',
      subjectId: 't9',
      capability: 'metrics.query',
      humanPolicy: 'allow',
    });
  });
});

describe('buildBatchBodies', () => {
  it('emits one body per capability with a shared policy', () => {
    const out = buildBatchBodies(ctx, ['metrics.query', 'runtime.apply'], 'block');
    expect(out).toEqual([
      { subjectType: 'team', subjectId: 't9', capability: 'metrics.query', humanPolicy: 'block' },
      { subjectType: 'team', subjectId: 't9', capability: 'runtime.apply', humanPolicy: 'block' },
    ]);
  });
});

describe('applyOptimistic', () => {
  const orgCtx = { connectorId: 'c1', subjectType: 'org' as const, subjectId: 'org1' };
  const existing: ConnectorPolicy[] = [
    {
      connectorId: 'c1',
      subjectType: 'org',
      subjectId: 'org1',
      capability: 'metrics.query',
      scope: null,
      humanPolicy: 'allow',
    },
  ];

  it('replaces an existing row in-place', () => {
    const out = applyOptimistic(existing, orgCtx, 'metrics.query', 'block');
    expect(out).toHaveLength(1);
    expect(out[0]?.humanPolicy).toBe('block');
  });

  it('inserts a new row when none exists', () => {
    const out = applyOptimistic(existing, orgCtx, 'runtime.apply', 'ask');
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.capability === 'runtime.apply')?.humanPolicy).toBe('ask');
  });
});

describe('applyReset', () => {
  it('removes the team-level row for the given capability', () => {
    const rows: ConnectorPolicy[] = [
      {
        connectorId: 'c1',
        subjectType: 'team',
        subjectId: 't9',
        capability: 'metrics.query',
        scope: null,
        humanPolicy: 'block',
      },
      {
        connectorId: 'c1',
        subjectType: 'team',
        subjectId: 't9',
        capability: 'runtime.apply',
        scope: null,
        humanPolicy: 'allow',
      },
    ];
    const out = applyReset(rows, 'metrics.query');
    expect(out).toHaveLength(1);
    expect(out[0]?.capability).toBe('runtime.apply');
  });
});
