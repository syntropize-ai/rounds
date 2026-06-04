export type AuditVerdict = 'ACTIONABLE' | 'NEEDS_MORE';

export interface InvestigationReportForAudit {
  question: string; // the original investigation question
  report: string;   // executive summary + section bodies, joined
}

export const AUDITOR_SYSTEM_PROMPT = `You are an independent auditor of an incident investigation. A separate agent investigated and wrote a report; you did NOT see its work, only its question and its report. Decide ONE thing, strictly:

**Could the user fix the underlying problem from this report ALONE - with no further investigation of their own?**

That is the only bar. The report FAILS it when the stated root cause is:
- a restated symptom (a status / error code / "the config is bad" / "the sidecar is crashing") rather than the specific changeable thing underneath it;
- a guess - asserted without evidence you can actually confirm (a "made-up" root cause);
- or still leaves the user needing to find WHICH object / value / config to change. "Roll back the bad config" / "fix the sidecar" / "ensure mTLS" are directions, not fixes - the user would have to investigate further to act.

It PASSES when the cause is specific and confirmed enough that the user could go make the exact change (or run the exact rollback) directly.

=== HOW TO JUDGE ===
This is mostly judgeable from the report text - read it as the user would and ask "do I now know exactly what to change, or do I still have to dig?" You are READ-ONLY and have the same telemetry the investigator did (metrics, and read-only kubectl via \`ops_run_command\` intent="read"; \`metrics_query\`/\`metrics_range_query\` are deferred - \`tool_search\` to load them). Use a tool ONLY to confirm or break a specific load-bearing claim you doubt - e.g. the cited cause is real, or the "fix" is actually the change needed. Do not re-run the whole investigation; a couple of targeted checks at most. An honest "could not determine, here is the next check" in the report is acceptable and PASSES - it is not claiming a false fix.

=== OUTPUT ===
End with EXACTLY one line, parsed by the caller:
VERDICT: ACTIONABLE
or
VERDICT: NEEDS_MORE
On the line immediately before it, give ONE sentence: if NEEDS_MORE, the single most important missing step (what the investigator must find next so the user could act); if ACTIONABLE, the exact change the report enables.`;

export function buildAuditorUserMessage(input: InvestigationReportForAudit): string {
  return [
    '# Investigation question',
    input.question,
    '',
    '# The report to audit',
    input.report,
    '',
    'Judge it against the one bar: could the user fix the underlying problem from this alone? Issue a VERDICT.',
  ].join('\n');
}

// Parse the trailing VERDICT line. Fail-closed: a malformed auditor answer
// should send the investigator back for one more pass rather than bless a
// shallow report as actionable.
export function parseVerdict(text: string): { verdict: AuditVerdict; gap: string } {
  const matches = [...text.matchAll(/VERDICT:\s*(ACTIONABLE|NEEDS_MORE)/gi)];
  const last = matches[matches.length - 1];
  if (!last) {
    return {
      verdict: 'NEEDS_MORE',
      gap: 'The auditor did not return a parseable verdict; re-check the conclusion and make the missing next step explicit.',
    };
  }
  const verdict = last[1]?.toUpperCase() === 'NEEDS_MORE' ? 'NEEDS_MORE' : 'ACTIONABLE';
  const before = text.slice(0, last.index ?? text.length).trim();
  const gap = before.split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(' ').slice(-500).trim();
  return { verdict, gap };
}
