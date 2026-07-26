/**
 * The Tier-1 runner: break something real, ask an ordinary question, grade the
 * answer.
 *
 *   ROUNDS_EVAL_URL=http://127.0.0.1:3000 \
 *   ROUNDS_EVAL_TOKEN=... \
 *   ROUNDS_EVAL_MODEL=claude-opus-4-8 \
 *   ROUNDS_EVAL_JUDGE_MODEL=deepseek-chat \
 *   ROUNDS_EVAL_JUDGE_URL=https://api.deepseek.com/v1/chat/completions \
 *   ROUNDS_EVAL_JUDGE_KEY=... \
 *   npx tsx tests/eval/tier1/run.ts --repeats 5
 *
 * This is a script, not a test. It needs a cluster, two vendors' API keys, and
 * the better part of an hour; wiring it into `vitest run` would make every PR
 * depend on all of that. It belongs in a nightly job whose output is a report
 * someone reads, not a green check nobody does.
 *
 * Three rules are enforced here rather than left to whoever runs it:
 *
 * - A failed run is never retried. Retrying until a scenario passes is how an
 *   eval becomes a demo. Runs that could not be graded are counted, named, and
 *   excluded from the denominator, and if there are too many the numbers are
 *   withheld entirely.
 * - A failed revert halts everything. The alternative is scoring every later
 *   scenario against a cluster that is still broken in a way nobody recorded,
 *   which produces numbers that look fine and mean nothing.
 * - Rates are withheld rather than qualified. Too few runs, one scenario
 *   dominating the sample, or a product that mostly declines to answer, and
 *   `summarize` returns null and says why. A percentage with a caveat beside it
 *   gets quoted without the caveat.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { score, applyJudge, summarize, type Score, type RunOutcome } from '../scoring/score.js';
import { toScoredReport, type SavedReportShape } from './report.js';
import { judge, assertDifferentVendors, type JudgeAnchors } from './judge.js';
import { ask, listInvestigationIds, findNewInvestigation, awaitReport, ApiUnreachable } from './driver.js';
import type { Scenario } from './scenario.js';
import { SCENARIOS } from './scenarios/index.js';

/** Generous. A run that exceeds it has failed to answer, and is graded as such. */
const INVESTIGATION_BUDGET_MS = 15 * 60 * 1000;

const MODEL = process.env['ROUNDS_EVAL_MODEL'] ?? '';
const JUDGE_MODEL = process.env['ROUNDS_EVAL_JUDGE_MODEL'] ?? '';

async function callJudgeModel(prompt: string): Promise<string> {
  const url = process.env['ROUNDS_EVAL_JUDGE_URL'];
  const key = process.env['ROUNDS_EVAL_JUDGE_KEY'];
  if (!url || !key) throw new Error('ROUNDS_EVAL_JUDGE_URL and ROUNDS_EVAL_JUDGE_KEY are required');
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`judge -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content ?? '';
}

interface RunRecord extends Score, RunOutcome {
  attempt: number;
  investigationId: string | null;
  reportedObject: string;
  reportedCause: string;
}

async function runOnce(s: Scenario, attempt: number): Promise<RunRecord> {
  const base = {
    scenarioId: s.id, kind: s.kind, rootCauseIsNotK8sObject: s.rootCauseIsNotK8sObject, attempt,
    investigationId: null, reportedObject: '', reportedCause: '',
  };
  const invalid = (reason: string): RunRecord =>
    ({ ...base, outcome: 'INVALID', reason, confidentlyWrong: false });

  try {
    // An inject that throws is a broken scenario, not a wrong answer. It is
    // reported and excluded rather than halting the night — one unwritable
    // manifest should not cost every other scenario its run.
    try {
      await s.inject();
    } catch (err) {
      return invalid(`inject failed: ${(err as Error).message}`);
    }

    await new Promise((r) => setTimeout(r, s.soakMs));

    // The fault must be visible in the data the product actually reads. A
    // cluster that looks healthy to Prometheus makes every investigation look
    // appropriately humble, and the run would score as a well-earned shrug.
    if (!(await s.confirmInjected())) return invalid('fault never became observable');

    const before = await listInvestigationIds();
    const { openedInvestigation } = await ask(s.question);
    const id = await findNewInvestigation(before, s.question);
    if (!id) {
      // The product's decision, not the harness's failure. Which decision it
      // was depends on whether it started at all: a draft is only persisted by
      // `investigation_complete`, so an abandoned investigation leaves no row.
      return {
        ...base,
        outcome: 'UNRESOLVED',
        reason: openedInvestigation
          ? 'opened an investigation but never completed it, so nothing was saved'
          : 'did not open an investigation',
        confidentlyWrong: false,
      };
    }

    const { report } = await awaitReport(id, INVESTIGATION_BUDGET_MS);

    // Confirm again, now that the window has closed. A fault that healed
    // partway through — a pod rescheduled, a rate window rolled past it —
    // leaves an investigation that honestly found nothing, and grading that as
    // a miss blames the product for the harness losing the fault.
    if (!(await s.confirmInjected())) {
      return invalid('the fault stopped being observable before the investigation finished');
    }

    const scored = toScoredReport(report as SavedReportShape | null);
    let result = score(scored, s.truth);

    if (result.needsJudge) {
      const anchors: JudgeAnchors = s.truth.judgeAnchors
        ?? { matches: [s.truth.mechanism], contradicts: [] };
      result = applyJudge(result, await judge(
        { truth: s.truth.mechanism, reported: result.needsJudge.reported, anchors },
        callJudgeModel,
      ));
    }

    return {
      ...base,
      ...result,
      investigationId: id,
      reportedObject: scored.rootCause?.object ?? '',
      reportedCause: scored.rootCause?.cause ?? '',
    };
  } catch (err) {
    if (err instanceof ApiUnreachable) return invalid(err.message);
    throw err;
  } finally {
    await s.revert();
    if (!(await s.confirmReverted())) {
      // Nothing after this point can be trusted, so nothing after this point runs.
      throw new Error(
        `${s.id} did not revert. The cluster is in an unknown state and every later scenario ` +
        'would be graded against it. Fix the cluster by hand before running again.',
      );
    }
  }
}

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(0)}%`);

function render(records: RunRecord[], repeats: number, scenarios: Scenario[]): string {
  const s = summarize(records);
  const injected = scenarios.filter((x) => x.kind === 'injected');
  const notK8s = injected.filter((x) => x.rootCauseIsNotK8sObject);

  const lines: string[] = [
    '# Tier-1 live-fault results',
    '',
    `Model under test: \`${MODEL}\` · judge: \`${JUDGE_MODEL}\``,
    `${scenarios.length} scenarios × ${repeats} runs · ` +
      `${s.injected.graded} graded on real faults, ${s.control.graded} on a healthy cluster, ` +
      `${s.injected.invalid + s.control.invalid} excluded`,
    '',
  ];

  if (s.withheld.length > 0) {
    // A percentage with a caveat next to it gets quoted without the caveat.
    lines.push('**No rates published.**', '');
    lines.push(...s.withheld.map((w) => `- ${w}`), '');
  }

  lines.push(
    '| Metric | Value | What it means |',
    '|---|---|---|',
    `| Answer rate | ${pct(s.answerRate)} | how often it committed to a cause on a real fault |`,
    `| Precision | ${pct(s.precision)} | of the times it committed, how often it was right |`,
    `| False alarm rate | ${pct(s.falseAlarmRate)} | how often it invented a cause on a healthy cluster |`,
    `| — on faults that are a Kubernetes object | ${pct(s.answerRateByClass.k8sObject)} | answer rate, resource faults only |`,
    `| — on faults that are not | ${pct(s.answerRateByClass.inProcess)} | answer rate, a value inside a process |`,
    '',
    'The last two are split because they are not one measurement. When the cause is a',
    'resource, naming it is most of the answer. When it is a value inside a process, the',
    'object decision separates little more than "the database or its client" and the rest',
    'is prose. A gate that answers most resource faults and almost none of the others is',
    'the result this split exists to show.',
    '',
    'Answer rate and precision are separate on purpose. A gate tightened until it never',
    'commits scores a perfect false-alarm rate and is useless; that shows here as answer',
    'rate collapsing while precision holds.',
    '',
    '| Count | |',
    '|---|---|',
    `| Correct | ${s.injected.correct} |`,
    `| Trapped — took the plausible neighbour | ${s.injected.trapped} |`,
    `| Declined to conclude | ${s.injected.unresolved} |`,
    `| Confident causes on a healthy cluster | ${s.control.confidentAnswers} |`,
    '',
    `Scenario mix: ${notK8s.length} of ${injected.length} faults have a root cause that is not a`,
    'Kubernetes object. A library that drifts toward zero here is grading name-matching',
    'rather than diagnosis, because a resource name is all a token scorer needs.',
    '',
    '## Every run',
    '',
    // "Eliminated" is here rather than in a rate because the gate is satisfied
    // by ruling out anything at all. A column of `no` next to a column of
    // CORRECT is the shape of a product guessing well.
    '| Scenario | # | Outcome | Reported | Eliminated something real | Why |',
    '|---|---|---|---|---|---|',
    ...records.map((r) => {
      const elim = r.eliminatedSomethingReal === null || r.eliminatedSomethingReal === undefined
        ? '—' : r.eliminatedSomethingReal ? 'yes' : 'no';
      return `| ${r.scenarioId} | ${r.attempt} | ${r.outcome} | ${r.reportedObject || '—'} | ${elim} | ${r.reason} |`;
    }),
  );
  return lines.join('\n');
}

/** `--only <id>` runs one scenario. For debugging a scenario, never for a number. */
function selectedScenarios(): Scenario[] {
  const at = process.argv.indexOf('--only');
  if (at < 0) return SCENARIOS;
  const wanted = new Set(process.argv[at + 1]?.split(',') ?? []);
  const picked = SCENARIOS.filter((s) => wanted.has(s.id));
  if (picked.length === 0) throw new Error(`--only matched nothing. Known: ${SCENARIOS.map((s) => s.id).join(', ')}`);
  return picked;
}

async function main(): Promise<void> {
  const repeatsArg = process.argv.indexOf('--repeats');
  const repeats = repeatsArg > 0 ? Number(process.argv[repeatsArg + 1]) : 1;
  if (!MODEL || !JUDGE_MODEL) throw new Error('ROUNDS_EVAL_MODEL and ROUNDS_EVAL_JUDGE_MODEL are required');
  assertDifferentVendors(MODEL, JUDGE_MODEL);

  const scenarios = selectedScenarios();
  const records: RunRecord[] = [];
  for (let attempt = 1; attempt <= repeats; attempt++) {
    for (const s of scenarios) {
      process.stderr.write(`[${s.id}] run ${attempt}/${repeats}\n`);
      const r = await runOnce(s, attempt);
      process.stderr.write(`  -> ${r.outcome}: ${r.reason}\n`);
      records.push(r);
    }
  }

  const out = join(dirname(fileURLToPath(import.meta.url)), 'results');
  mkdirSync(out, { recursive: true });
  const path = join(out, 'latest.md');
  writeFileSync(path, render(records, repeats, scenarios));
  process.stderr.write(`\nwrote ${path}\n`);
}

// Not top-level await: the repo root is CommonJS, so tsx compiles this file to
// CJS and top-level await is a syntax error there.
main().catch((err: Error) => {
  process.stderr.write(`\n${err.message}\n`);
  process.exitCode = 1;
});
