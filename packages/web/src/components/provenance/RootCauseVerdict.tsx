/**
 * Whether the product stands behind this conclusion.
 *
 * The report used to open with the model name, the tool-call count and the
 * cost. It did not say whether the root cause had been verified — the one
 * question a reader actually has, and the only thing here that changes what
 * they should do next. A report that names a cause confidently and says
 * nothing about its own confidence is asking to be trusted on tone.
 *
 * Two design choices are load-bearing:
 *
 * **Unverified is not an error.** No red, no warning triangle, no "failed".
 * The gate withholding a verdict is the product working — it is the difference
 * between this and a tool that always sounds certain. Styling it as a failure
 * teaches people to see the honest state as the broken state, and they start
 * reading past it.
 *
 * **What is missing comes before why it matters.** Someone reading this at 3am
 * wants the next action, not a lecture on evidence standards. The reasons are
 * rendered as things still to check, in the plain wording the gate provides.
 */

import type { Provenance } from '@agentic-obs/common';
import { explainGateReasons } from '@agentic-obs/common';

type Gate = NonNullable<Provenance['rootCauseGate']>;

function Verified({ gate }: { gate: Gate }) {
  const target = gate.rootCause?.object;
  return (
    <div className="rounded-lg border border-success/30 bg-success/5 px-4 py-3 space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-success text-[11px] font-bold tracking-widest uppercase">
          Root cause verified
        </span>
      </div>
      <p className="text-[13px] text-on-surface-variant leading-relaxed">
        {target
          ? <>The evidence below independently supports <span className="font-semibold text-on-surface">{target}</span> as the cause.</>
          : 'The evidence below independently supports the stated cause.'}
        {gate.validationMethod
          ? <> Confirm a fix by: {gate.validationMethod}</>
          : null}
      </p>
    </div>
  );
}

function NotVerified({ gate }: { gate: Gate }) {
  // `reasons` is empty when the agent itself declined to conclude rather than
  // being downgraded. Saying "here is what is missing" and then listing nothing
  // reads as a bug, so that case gets its own sentence.
  const missing = explainGateReasons(gate.reasons);
  const next = gate.rootCause?.nextCheck;

  return (
    <div className="rounded-lg border border-outline/40 bg-surface-variant/40 px-4 py-3 space-y-2">
      <span className="text-on-surface-variant text-[11px] font-bold tracking-widest uppercase">
        Not verified — treat as a lead
      </span>
      {missing.length > 0 ? (
        <>
          <p className="text-[13px] text-on-surface-variant leading-relaxed">
            This is the most likely explanation found so far, but it does not yet meet the bar
            to act on. Still to check:
          </p>
          <ul className="space-y-1 pl-4">
            {missing.map((reason, i) => (
              <li key={i} className="text-[13px] text-on-surface-variant leading-relaxed list-disc">
                {reason}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-[13px] text-on-surface-variant leading-relaxed">
          The investigation did not reach a conclusion it could stand behind.
        </p>
      )}
      {next ? (
        <p className="text-[13px] text-on-surface leading-relaxed">
          <span className="font-semibold">Next check:</span> {next}
        </p>
      ) : null}
    </div>
  );
}

export default function RootCauseVerdict({ provenance }: { provenance: Provenance }) {
  const gate = provenance.rootCauseGate;
  // Reports saved before the gate existed carry no verdict. Inventing one
  // either way would be worse than the silence they already have.
  if (!gate) return null;
  return gate.status === 'passed' ? <Verified gate={gate} /> : <NotVerified gate={gate} />;
}
