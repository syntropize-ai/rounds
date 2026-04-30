import { describe, it, expect } from 'vitest';
import {
  handleDatasourcesSuggest,
  handleDatasourcesPin,
  handleDatasourcesUnpin,
} from '../datasources.js';
import { makeFakeActionContext } from '../_test-helpers.js';
import { AdapterRegistry } from '../../../adapters/registry.js';
import type { DatasourceConfig } from '../../types.js';

interface DatasourceFixture {
  id: string;
  name: string;
  type: string;
  isDefault?: boolean;
  environment?: string;
  cluster?: string;
}

function makeRegistryFromFixtures(fixtures: DatasourceFixture[]): AdapterRegistry {
  const reg = new AdapterRegistry();
  for (const f of fixtures) {
    reg.register({
      info: {
        id: f.id,
        name: f.name,
        type: f.type,
        signalType: 'metrics',
        ...(f.isDefault ? { isDefault: true } : {}),
      },
    });
  }
  return reg;
}

function fixturesToConfigs(fixtures: DatasourceFixture[]): DatasourceConfig[] {
  return fixtures.map((f) => ({
    id: f.id,
    name: f.name,
    type: f.type,
    url: 'http://example',
    ...(f.environment ? { environment: f.environment } : {}),
    ...(f.cluster ? { cluster: f.cluster } : {}),
    ...(f.isDefault ? { isDefault: true } : {}),
  }));
}

function ctxWith(fixtures: DatasourceFixture[]) {
  return makeFakeActionContext({
    adapters: makeRegistryFromFixtures(fixtures),
    allDatasources: fixturesToConfigs(fixtures),
  });
}

describe('handleDatasourcesSuggest — decision pyramid', () => {
  it('layer 1: matches a name substring in userIntent → high confidence', async () => {
    const ctx = ctxWith([
      { id: 'ds-prod', name: 'prod-prom', type: 'prometheus', isDefault: true },
      { id: 'ds-stage', name: 'stage-prom', type: 'prometheus' },
    ]);
    const raw = await handleDatasourcesSuggest(ctx, {
      userIntent: 'p99 latency on stage-prom please',
    });
    const out = JSON.parse(raw);
    expect(out.recommendedId).toBe('ds-stage');
    expect(out.confidence).toBe('high');
    expect(out.alternatives.map((a: { id: string }) => a.id)).toEqual(['ds-prod']);
  });

  it('layer 1: matches an environment substring → high confidence', async () => {
    const ctx = ctxWith([
      { id: 'a', name: 'alpha', type: 'prometheus', environment: 'staging' },
      { id: 'b', name: 'beta', type: 'prometheus', environment: 'production', isDefault: true },
    ]);
    const out = JSON.parse(
      await handleDatasourcesSuggest(ctx, { userIntent: 'show staging errors' }),
    );
    expect(out.recommendedId).toBe('a');
    expect(out.confidence).toBe('high');
  });

  it('layer 2: no hint → falls back to the default datasource (medium)', async () => {
    const ctx = ctxWith([
      { id: 'ds-prod', name: 'prod-prom', type: 'prometheus', isDefault: true },
      { id: 'ds-stage', name: 'stage-prom', type: 'prometheus' },
    ]);
    const out = JSON.parse(
      await handleDatasourcesSuggest(ctx, { userIntent: 'cpu usage trend' }),
    );
    expect(out.recommendedId).toBe('ds-prod');
    expect(out.confidence).toBe('medium');
  });

  it('layer 3: multiple non-default + no hint → recommendedId null and AMBIGUOUS reason', async () => {
    const ctx = ctxWith([
      { id: 'ds-a', name: 'alpha', type: 'prometheus' },
      { id: 'ds-b', name: 'beta', type: 'prometheus' },
    ]);
    const out = JSON.parse(
      await handleDatasourcesSuggest(ctx, { userIntent: 'show me cpu usage' }),
    );
    expect(out.recommendedId).toBeNull();
    expect(out.confidence).toBe('low');
    expect(out.reason).toMatch(/AMBIGUOUS/);
    expect(out.alternatives.map((a: { id: string }) => a.id).sort()).toEqual(['ds-a', 'ds-b']);
  });

  it('single candidate, no default, no hint → low confidence picked-first fallback', async () => {
    const ctx = ctxWith([{ id: 'only', name: 'only-prom', type: 'prometheus' }]);
    const out = JSON.parse(
      await handleDatasourcesSuggest(ctx, { userIntent: 'whatever' }),
    );
    expect(out.recommendedId).toBe('only');
    expect(out.confidence).toBe('low');
    expect(out.reason).toMatch(/no clear hint/);
  });

  it('honours the optional type filter', async () => {
    const ctx = ctxWith([
      { id: 'ds-prom', name: 'prom', type: 'prometheus', isDefault: true },
      { id: 'ds-loki', name: 'loki', type: 'loki' },
    ]);
    const out = JSON.parse(
      await handleDatasourcesSuggest(ctx, { userIntent: 'errors', type: 'loki' }),
    );
    expect(out.recommendedId).toBe('ds-loki');
    expect(out.confidence).toBe('low'); // single candidate, no default in the filtered set
  });

  it('returns an empty result when no datasources match', async () => {
    const ctx = ctxWith([]);
    const out = JSON.parse(
      await handleDatasourcesSuggest(ctx, { userIntent: 'cpu' }),
    );
    expect(out.recommendedId).toBeNull();
    expect(out.alternatives).toEqual([]);
  });

  it('emits a tool_call and tool_result via withToolEventBoundary', async () => {
    const ctx = ctxWith([{ id: 'only', name: 'only-prom', type: 'prometheus', isDefault: true }]);
    await handleDatasourcesSuggest(ctx, { userIntent: 'cpu' });
    const tools = ctx.sendEvent.mock.calls.map((c) => c[0]);
    expect(tools[0]).toMatchObject({ type: 'tool_call', tool: 'datasources_suggest' });
    expect(tools.at(-1)).toMatchObject({ type: 'tool_result', tool: 'datasources_suggest', success: true });
  });
});

describe('handleDatasourcesPin / handleDatasourcesUnpin', () => {
  it('pin writes to ctx.sessionDatasourcePins under the type slot (defaulting to prometheus)', async () => {
    const ctx = ctxWith([{ id: 'ds-prod', name: 'prod', type: 'prometheus', isDefault: true }]);
    const out = await handleDatasourcesPin(ctx, { datasourceId: 'ds-prod' });
    expect(out).toMatch(/Pinned prometheus datasource to ds-prod/);
    const bag = (ctx as unknown as { sessionDatasourcePins: Record<string, string> });
    expect(bag.sessionDatasourcePins).toEqual({ prometheus: 'ds-prod' });
  });

  it('pin requires datasourceId', async () => {
    const ctx = ctxWith([]);
    const out = await handleDatasourcesPin(ctx, {});
    expect(out).toMatch(/Error/);
  });

  it('unpin removes the slot and is idempotent', async () => {
    const ctx = ctxWith([]);
    await handleDatasourcesPin(ctx, { datasourceId: 'ds-x', type: 'loki' });
    const removed = await handleDatasourcesUnpin(ctx, { type: 'loki' });
    expect(removed).toMatch(/Unpinned loki datasource/);
    const again = await handleDatasourcesUnpin(ctx, { type: 'loki' });
    expect(again).toMatch(/No loki datasource was pinned/);
  });
});
