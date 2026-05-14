# Investigations

Investigations collect evidence around an operational question and turn it into a report. Start one from chat, a firing alert, the feed, or a related resource.

## Common tasks

- Investigate a latency, error, saturation, restart, or alert symptom.
- Correlate metrics, logs, recent changes, and Kubernetes state when connected.
- Save a structured report with evidence and conclusions.
- Continue the investigation with follow-up questions.
- Create or review a remediation plan when the evidence supports action.

## Start an investigation

Ask from Home:

> Investigate why checkout p99 latency increased after 09:00.

Or open **Alerts** and choose an alert's investigate action.

Rounds creates an investigation record, queries relevant sources, writes sections as evidence arrives, and completes the report when it has a useful conclusion.

## Investigation report

Reports are organized for operators:

- summary;
- symptom timeline;
- hypotheses;
- evidence;
- conclusion;
- recommended next actions.

Evidence should link back to the metric, log, change, or cluster observation used to support the claim.

## Follow-ups

Use the same thread for questions like:

> Did this affect only prod?

> Compare this to last week.

> What should I check before rolling back?

The agent keeps the investigation context and adds new evidence when needed.

## Remediation

When Kubernetes or other ops connectors are configured, Rounds can propose a remediation plan. Risky actions go through confirmation or Action Center approval before execution.

## Limits

- The quality of an investigation depends on connected metrics, logs, change events, and cluster access.
- Mutating actions require permissions and approval.
- Long investigations may summarize earlier context to stay within model limits.
