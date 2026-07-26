/**
 * Tier-0 investigation quality: frozen trajectories replayed through the real
 * handler and the real evidence gate.
 *
 * The repo has thousands of unit tests and, until this file, none that asked
 * whether an investigation reaches a defensible conclusion. That is the
 * product. A prompt edit, a gate tweak, or a model swap can degrade it while
 * every existing test stays green.
 *
 * These run on every PR because they need no cluster, no API key and no
 * network — a trajectory is a recording of what an agent did, and the gate is
 * a pure function of that. They catch the deterministic half of the problem:
 * evidence-gate regressions, and changes that quietly make it possible to
 * satisfy the gate without doing the work. The other half — whether a live
 * agent reaches the right answer on a fault we injected — needs a cluster and
 * belongs in a nightly job.
 *
 * Adding a trajectory: drop a JSON file in ./trajectories. Prefer real runs
 * over invented ones, and say in `note` where it came from.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateInvestigationEvidenceGate } from '../../packages/agent-core/src/agent/evidence-gate.js';
import { handleInvestigationRecordCheck } from '../../packages/agent-core/src/agent/handlers/investigation.js';
import { makeFakeActionContext } from '../../packages/agent-core/src/agent/handlers/_test-helpers.js';
import type { InvestigationCompletionClaim } from '../../packages/agent-core/src/agent/investigation-state.js';

const TRAJECTORY_DIR = join(dirname(fileURLToPath(import.meta.url)), 'trajectories');

/** What we assert about a trajectory once it has been replayed. */
type Expectation =
  /** The gate accepts it: this investigation may back a remediation plan. */
  | 'passed'
  /** The gate accepts the checks but withholds the verified verdict. */
  | 'unresolved'
  /** A check is refused at record time — the work behind it never happened. */
  | 'rejected-at-record';

interface Trajectory {
  id: string;
  note: string;
  expect: Expectation;
  why: string;
  /** Read-tool calls that actually executed, per family, before recording. */
  reads: { metric?: number; log?: number; ops?: number; change?: number };
  checks: Array<Record<string, unknown>>;
  claim: InvestigationCompletionClaim;
  /** Present when the fixture pins behaviour we know to be wrong. */
  knownGap?: string;
}

function loadTrajectories(): Trajectory[] {
  return readdirSync(TRAJECTORY_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(TRAJECTORY_DIR, f), 'utf8')) as Trajectory);
}

/**
 * Replay one trajectory: credit the reads that ran, record each check through
 * the real handler, then put the claim through the real gate.
 */
async function replay(t: Trajectory) {
  const ctx = makeFakeActionContext({ activeInvestigationId: t.id });
  ctx.investigationProvenance.set(t.id, {
    runId: t.id,
    metricReadCalls: t.reads.metric ?? 0,
    logReadCalls: t.reads.log ?? 0,
    opsReadCalls: t.reads.ops ?? 0,
    changeReadCalls: t.reads.change ?? 0,
  } as never);

  const refusals: string[] = [];
  for (const check of t.checks) {
    const result = await handleInvestigationRecordCheck(ctx, check);
    if (result.startsWith('Error:')) refusals.push(result);
  }

  const state = ctx.investigationStates.get(t.id);
  const gate = evaluateInvestigationEvidenceGate(state, t.claim);
  return { refusals, gate, recorded: state?.checks.length ?? 0 };
}

describe('investigation quality — frozen trajectories', () => {
  const trajectories = loadTrajectories();

  it('has trajectories to replay', () => {
    // A silently empty suite is worse than no suite: it reports green forever.
    expect(trajectories.length).toBeGreaterThan(0);
  });

  for (const t of trajectories) {
    it(`${t.id}: ${t.expect}`, async () => {
      const { refusals, gate, recorded } = await replay(t);

      if (t.expect === 'rejected-at-record') {
        expect(
          refusals.length,
          `${t.why}\n\nEvery check was accepted, so nothing stopped this trajectory from reaching the gate.`,
        ).toBeGreaterThan(0);
        expect(recorded).toBeLessThan(t.checks.length);
        return;
      }

      expect(
        refusals,
        `${t.id} should replay cleanly, but a check was refused:\n${refusals.join('\n')}`,
      ).toEqual([]);

      expect(
        gate.status,
        `${t.why}\n\nGate reasons: ${gate.reasons.join('; ') || '(none)'}`,
      ).toBe(t.expect);
    });
  }
});

describe('investigation quality — known gaps', () => {
  // Fixtures that pin behaviour we consider wrong. They exist so the gap is
  // visible in CI rather than living in someone's memory, and so that whoever
  // closes it is told which fixture to update.
  const gaps = loadTrajectories().filter((t) => t.knownGap);

  it('every known gap explains itself and how it will be closed', () => {
    for (const t of gaps) {
      expect(t.knownGap!.length, `${t.id} needs a real explanation`).toBeGreaterThan(80);
    }
  });

  it('reports the current gap count', () => {
    // Not an assertion about the number — a place for it to be seen. Update
    // deliberately when a gap closes.
    expect(gaps.map((g) => g.id).sort()).toEqual(['missing-source-as-ruled-out']);
  });
});
