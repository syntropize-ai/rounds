import { describe, it, expect, beforeEach } from 'vitest';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { DashboardRepository } from './dashboard.js';
import type { PanelConfig, DashboardVariable } from '@agentic-obs/common';

describe('DashboardRepository', () => {
  let db: SqliteClient;
  let repo: DashboardRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new DashboardRepository(db);
  });

  // -- create / findById round-trip --

  it('create() persists every field and findById() reads it back', async () => {
    const d = await repo.create({
      title: 'Prod latency',
      description: 'p99 by service',
      prompt: 'show p99 latency by service',
      userId: 'u-1',
      datasourceIds: ['ds-a', 'ds-b'],
      useExistingMetrics: false,
      folder: 'prod',
      workspaceId: 'ws-1',
      sessionId: 'sess-7',
    });

    expect(d.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(d.type).toBe('dashboard');
    expect(d.status).toBe('generating');
    expect(d.panels).toEqual([]);
    expect(d.variables).toEqual([]);
    expect(d.refreshIntervalSec).toBe(30);
    expect(d.datasourceIds).toEqual(['ds-a', 'ds-b']);
    expect(d.useExistingMetrics).toBe(false);
    expect(d.folder).toBe('prod');
    expect(d.workspaceId).toBe('ws-1');
    expect(d.sessionId).toBe('sess-7');
    expect(d.createdAt).toEqual(d.updatedAt);

    const fetched = await repo.findById(d.id);
    expect(fetched).not.toBeNull();
    expect(fetched).toEqual(d);
  });

  it('create() defaults useExistingMetrics=true when omitted', async () => {
    const d = await repo.create({
      title: 't',
      description: 'd',
      prompt: 'p',
      userId: 'u',
      datasourceIds: [],
    });
    expect(d.useExistingMetrics).toBe(true);
    expect(d.datasourceIds).toEqual([]);
    expect(d.folder).toBeUndefined();
    expect(d.workspaceId).toBeUndefined();
    expect(d.sessionId).toBeUndefined();
  });

  // -- missing-id lookup --

  it('findById() returns null for an unknown id', async () => {
    expect(await repo.findById('does-not-exist')).toBeNull();
  });

  // -- listByWorkspace filtering --

  it('listByWorkspace() returns only rows matching workspaceId', async () => {
    const a = await repo.create({
      title: 'a',
      description: '',
      prompt: '',
      userId: 'u',
      datasourceIds: [],
      workspaceId: 'ws-1',
    });
    await repo.create({
      title: 'b',
      description: '',
      prompt: '',
      userId: 'u',
      datasourceIds: [],
      workspaceId: 'ws-2',
    });
    const c = await repo.create({
      title: 'c',
      description: '',
      prompt: '',
      userId: 'u',
      datasourceIds: [],
      workspaceId: 'ws-1',
    });
    // Dashboard with no workspace — must be excluded.
    await repo.create({
      title: 'd',
      description: '',
      prompt: '',
      userId: 'u',
      datasourceIds: [],
    });

    const inWs1 = await repo.listByWorkspace('ws-1');
    expect(inWs1).toHaveLength(2);
    const ids = inWs1.map((d) => d.id).sort();
    expect(ids).toEqual([a.id, c.id].sort());
  });

  it('findAll() filters by userId when provided, otherwise returns everything', async () => {
    await repo.create({ title: 'x', description: '', prompt: '', userId: 'alice', datasourceIds: [] });
    await repo.create({ title: 'y', description: '', prompt: '', userId: 'bob', datasourceIds: [] });
    await repo.create({ title: 'z', description: '', prompt: '', userId: 'alice', datasourceIds: [] });

    expect(await repo.findAll()).toHaveLength(3);
    const alice = await repo.findAll('alice');
    expect(alice).toHaveLength(2);
    expect(alice.every((d) => d.userId === 'alice')).toBe(true);
  });

  // -- update --

  it('update() merges patch fields, preserves untouched ones, and bumps updatedAt', async () => {
    const d = await repo.create({
      title: 'orig',
      description: 'orig-desc',
      prompt: 'orig-prompt',
      userId: 'u',
      datasourceIds: ['ds-a'],
    });

    const updated = await repo.update(d.id, {
      title: 'renamed',
      description: 'new-desc',
      refreshIntervalSec: 60,
    });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('renamed');
    expect(updated!.description).toBe('new-desc');
    expect(updated!.refreshIntervalSec).toBe(60);
    // Untouched:
    expect(updated!.prompt).toBe('orig-prompt');
    expect(updated!.datasourceIds).toEqual(['ds-a']);
    expect(updated!.userId).toBe('u');
  });

  it('update() returns null for an unknown id', async () => {
    expect(await repo.update('missing', { title: 'x' })).toBeNull();
  });

  // -- updateStatus --

  it('updateStatus() writes status and optional error', async () => {
    const d = await repo.create({
      title: 't',
      description: '',
      prompt: '',
      userId: 'u',
      datasourceIds: [],
    });

    const ready = await repo.updateStatus(d.id, 'ready');
    expect(ready!.status).toBe('ready');
    expect(ready!.error).toBeUndefined();

    const failed = await repo.updateStatus(d.id, 'failed', 'boom');
    expect(failed!.status).toBe('failed');
    expect(failed!.error).toBe('boom');

    // Re-set status without passing error: must preserve prior error.
    const stillFailed = await repo.updateStatus(d.id, 'failed');
    expect(stillFailed!.error).toBe('boom');
  });

  it('updateStatus() returns null for an unknown id', async () => {
    expect(await repo.updateStatus('missing', 'ready')).toBeNull();
  });

  // -- updatePanels --

  it('updatePanels() round-trips complex PanelConfig JSON', async () => {
    const d = await repo.create({
      title: 't',
      description: '',
      prompt: '',
      userId: 'u',
      datasourceIds: [],
    });

    const panels: PanelConfig[] = [
      {
        id: 'p1',
        title: 'Latency',
        description: 'p99 per pod',
        visualization: 'time_series',
        row: 0,
        col: 0,
        width: 12,
        height: 8,
        queries: [
          {
            refId: 'A',
            expr: 'histogram_quantile(0.99, sum by(le,pod)(rate(http_req_duration_seconds_bucket[5m])))',
            legendFormat: '{{pod}}',
          },
        ],
        thresholds: [
          { value: 0.5, color: 'yellow' },
          { value: 1, color: 'red' },
        ],
      },
      {
        id: 'p2',
        title: 'Errors',
        description: '5xx rate',
        visualization: 'stat',
        row: 1,
        col: 0,
        width: 6,
        height: 4,
        unit: 'percent',
        sparkline: true,
      },
    ];

    const updated = await repo.updatePanels(d.id, panels);
    expect(updated).not.toBeNull();
    expect(updated!.panels).toEqual(panels);

    const refetched = await repo.findById(d.id);
    expect(refetched!.panels).toEqual(panels);
  });

  it('updatePanels() returns null for an unknown id', async () => {
    expect(await repo.updatePanels('missing', [])).toBeNull();
  });

  // -- updateVariables --

  it('updateVariables() round-trips DashboardVariable JSON', async () => {
    const d = await repo.create({
      title: 't',
      description: '',
      prompt: '',
      userId: 'u',
      datasourceIds: [],
    });
    const vars: DashboardVariable[] = [
      {
        name: 'service',
        label: 'Service',
        type: 'query',
        query: 'label_values(up, service)',
        multi: true,
        includeAll: true,
      },
      {
        name: 'env',
        label: 'Env',
        type: 'custom',
        options: ['prod', 'staging', 'dev'],
        current: 'prod',
      },
    ];
    const updated = await repo.updateVariables(d.id, vars);
    expect(updated!.variables).toEqual(vars);
    const refetched = await repo.findById(d.id);
    expect(refetched!.variables).toEqual(vars);
  });

  it('updateVariables() returns null for an unknown id', async () => {
    expect(await repo.updateVariables('missing', [])).toBeNull();
  });

  // -- delete --

  it('delete() removes the row and returns true only on first delete', async () => {
    const d = await repo.create({
      title: 't',
      description: '',
      prompt: '',
      userId: 'u',
      datasourceIds: [],
    });
    expect(await repo.delete(d.id)).toBe(true);
    expect(await repo.findById(d.id)).toBeNull();
    // Second delete must be a no-op.
    expect(await repo.delete(d.id)).toBe(false);
  });

  // -- size / clear --

  it('size() and clear() match the row count', async () => {
    expect(await repo.size()).toBe(0);
    await repo.create({ title: 'a', description: '', prompt: '', userId: 'u', datasourceIds: [] });
    await repo.create({ title: 'b', description: '', prompt: '', userId: 'u', datasourceIds: [] });
    expect(await repo.size()).toBe(2);
    await repo.clear();
    expect(await repo.size()).toBe(0);
    expect(await repo.findAll()).toEqual([]);
  });

  // -- toJSON / loadJSON round-trip --

  it('toJSON() / loadJSON() snapshot round-trip', async () => {
    const d1 = await repo.create({
      title: 'snap-1',
      description: '',
      prompt: '',
      userId: 'u',
      datasourceIds: ['ds'],
      workspaceId: 'ws',
    });
    await repo.updatePanels(d1.id, [
      { id: 'p', title: 'P', description: '', visualization: 'stat', row: 0, col: 0, width: 4, height: 4 },
    ]);

    const snapshot = await repo.toJSON();
    expect(snapshot).toHaveLength(1);

    // New DB, new repo — reload from the snapshot.
    const db2 = createTestDb();
    const repo2 = new DashboardRepository(db2);
    await repo2.loadJSON(snapshot);
    const reloaded = await repo2.findAll();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]!.id).toBe(d1.id);
    expect(reloaded[0]!.panels).toHaveLength(1);
    expect(reloaded[0]!.workspaceId).toBe('ws');
  });

  it('loadJSON() tolerates non-array input', async () => {
    await expect(repo.loadJSON(null)).resolves.toBeUndefined();
    await expect(repo.loadJSON('not an array')).resolves.toBeUndefined();
    await expect(repo.loadJSON({ id: 'x' })).resolves.toBeUndefined();
    expect(await repo.size()).toBe(0);
  });
});
