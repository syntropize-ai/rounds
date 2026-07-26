/**
 * Every way a source can fail to answer must be marked, not just the first one
 * anybody happened to wire up.
 *
 * `sourceUnavailable()` is the only thing preventing a failed read from backing
 * a `ruled_out` hypothesis, which in turn feeds the evidence gate toward
 * `passed`. It shipped with exactly one call site — "no change-event connector
 * configured" — while roughly a dozen sibling branches returned plain strings:
 * Loki down, Prometheus query failed, ops runner absent, unknown connector.
 * Each of those read to the ledger as "the source answered", so an
 * investigation could eliminate a hypothesis on the strength of a backend
 * being unreachable.
 *
 * The half that matters just as much is the negative: a source that answered
 * "nothing here" must stay unmarked, or the product loses the ability to rule
 * anything out at all.
 */

import { describe, it, expect, vi } from 'vitest';
import { isSourceUnavailable } from '../_shared.js';
import { handleLogsQuery, handleLogsLabels } from '../logs.js';
import { handleMetricsQuery } from '../metrics.js';
import { handleChangesListRecent } from '../changes.js';
import { handleOpsRunCommand } from '../ops.js';
import { makeFakeActionContext } from '../_test-helpers.js';

/** A context whose registry knows about nothing at all. */
function emptyCtx() {
  return makeFakeActionContext({});
}

describe('a source that could not be consulted is marked', () => {
  it('unknown logs connector', async () => {
    const out = await handleLogsQuery(emptyCtx(), { sourceId: 'nope', query: '{app="x"}' });
    expect(isSourceUnavailable(out)).toBe(true);
  });

  it('unknown logs connector on a labels call', async () => {
    const out = await handleLogsLabels(emptyCtx(), { sourceId: 'nope' });
    expect(isSourceUnavailable(out)).toBe(true);
  });

  it('unknown metrics connector', async () => {
    const out = await handleMetricsQuery(emptyCtx(), { sourceId: 'nope', query: 'up' });
    expect(isSourceUnavailable(out)).toBe(true);
  });

  it('unknown changes connector — the branch next to the one that was already marked', async () => {
    const out = await handleChangesListRecent(emptyCtx(), { sourceId: 'nope' });
    expect(isSourceUnavailable(out)).toBe(true);
  });

  it('no change connector configured at all', async () => {
    const out = await handleChangesListRecent(emptyCtx(), {});
    expect(isSourceUnavailable(out)).toBe(true);
  });

  it('ops runner not configured', async () => {
    const out = await handleOpsRunCommand(emptyCtx(), { command: 'kubectl get pods' });
    expect(isSourceUnavailable(out)).toBe(true);
  });
});

describe('the mark never reaches the user', () => {
  it('is absent from the tool_result the UI renders', async () => {
    // `withToolEventBoundary` uses the returned string as the SSE summary, so
    // marking the return value naively would print " source-unavailable " in
    // the activity feed.
    const events: Array<{ type: string; summary?: string }> = [];
    const ctx = makeFakeActionContext({});
    ctx.sendEvent = vi.fn((e: unknown) => { events.push(e as never); }) as never;

    await handleOpsRunCommand(ctx, { command: 'kubectl get pods' });
    await handleChangesListRecent(ctx, {});
    await handleMetricsQuery(ctx, { sourceId: 'nope', query: 'up' });

    const summaries = events.filter((e) => e.type === 'tool_result').map((e) => e.summary ?? '');
    expect(summaries.length).toBeGreaterThan(0);
    for (const s of summaries) {
      expect(s, s).not.toContain('source-unavailable');
    }
  });
});

describe('a source that answered stays unmarked', () => {
  /** A changes connector that is up and genuinely has nothing to report. */
  function ctxWithWorkingChanges() {
    const ctx = makeFakeActionContext({});
    ctx.adapters.register({
      info: { id: 'ch-1', name: 'changes', type: 'change-event', signalType: 'changes' },
      changes: { listRecent: async () => [] },
    } as never);
    return ctx;
  }

  it('"no changes in the window" is a real answer and can rule things out', async () => {
    // The whole point of the distinction. If this were marked too, the product
    // could never eliminate "a recent deploy caused it", which is the single
    // most valuable elimination in most incidents.
    const out = await handleChangesListRecent(ctxWithWorkingChanges(), { sourceId: 'ch-1' });
    expect(out).toContain('No changes');
    expect(isSourceUnavailable(out)).toBe(false);
  });
});
