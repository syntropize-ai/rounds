# What stands between the agent and your cluster

Rounds can run commands against production. This page states exactly what
decides whether a command runs, what those checks can and cannot see, and which
control you should actually be relying on.

It is deliberately specific. A security posture you cannot inspect is a
security posture you cannot trust, and "the AI is careful" is not a control.

## The layers, in order

A command from the agent passes through four gates. The first one that says no
wins.

| # | Gate | Decides | Where |
|---|---|---|---|
| 1 | **Tool ceiling** | Whether this agent type can call this tool at all | `agent-registry.ts` (`allowedTools`) |
| 2 | **Permission mode** | Whether this agent may mutate anything (`read_only`, `propose_only`, …) | `permission-gate.ts` |
| 3 | **RBAC** | Whether the *human* on whose behalf it runs holds the permission | `tool-permissions.ts` |
| 4 | **Command allowlist** | Whether this specific command is permitted for this connector | `ops-command-runner.ts` |

Two properties worth knowing:

**A denial is not an error.** The loop turns it into an observation the model
reads — `permission denied: <action>` — so the agent reasons about the refusal
and takes another route instead of crashing. Denials are visible in the
transcript.

**There is no ambient authority.** The ReAct loop refuses to start without a
bound identity. A background investigation runs as a named service account, and
its actions attribute to that account in the audit log.

## The command allowlist (gate 4)

This is the layer specific to running things in your cluster, and the one to
understand in detail.

Every `kubectl` invocation inside a command string is extracted and checked —
including invocations behind a pipe, `&&`, `$(…)`, `xargs`, spelled with a path
(`/usr/bin/kubectl`), or re-entered through `sh -c "…"`. Each is parsed into
argv and checked against the connector's allowed verbs and namespaces.

**It fails closed.** When a namespace-gated verb runs against a connector that
restricts namespaces and the namespace cannot be determined, the command is
denied rather than allowed. This is why `kubectl exec mypod -- ls` is refused
under a namespace-restricted connector: without `-n`, the gate cannot prove the
target is in scope.

Two bypasses were found by probing and are now closed, both worth knowing about
because they show the shape of the risk:

- `sh -c "kubectl get secret … -n kube-system"` — the quoted body survived
  tokenisation as a single opaque token, so wrapping any command in a shell
  disabled the gate entirely.
- `kubectl cp kube-system/etcd-0:/etc/kubernetes/pki/ca.key ./ca.key` — `cp`
  carries its namespace inside the operand rather than in `-n`, so the
  allowlist saw no namespace at all.

Both had the same root cause: a namespace-gated verb whose namespace could not
be determined was allowed. That is now a denial.

## Risk classification, and its limits

Separately from the allowlist, commands are classified into four levels to
decide whether a confirmation card appears:

| Level | Matches | Behaviour |
|---|---|---|
| `critical` | `kubectl delete`/`drain`; shell `rm`, `mv`, `dd`, `mkfs`, redirect to `/` | Always confirms. Never auto-approved, under any setting. |
| `high` | `kubectl apply`/`create`/`patch`/`edit`/`replace`/`scale`/`cordon`/`rollout`/`exec`/`cp`/`annotate`/`label`/`taint`/`set` | Confirms |
| `medium` | Mentions `kubectl` but matches no known read verb | Confirms — an unfamiliar subcommand prompts rather than passing |
| `low` | Known read verbs: `get`, `describe`, `logs`, `events`, `top`, `version`, … | May skip confirmation |

**This classifier works by matching command text, and that has a ceiling.**
Pattern matching cannot be proven complete: the two bypasses above were found
by probing, and the honest position is that others may exist. The unknown-verb
default (`medium`, therefore confirms) limits the damage, but does not remove
the class of problem.

**So do not rely on the classifier as your primary control.** The controls to
rely on are the connector capability policy, the namespace allowlist, and the
approval step — all of which operate on structure rather than on text. The
classifier is defence in depth.

## What the evidence gate does and does not prove

The evidence gate decides whether an investigation may call a root cause
verified, and whether that investigation can back a remediation plan. It is
worth being precise about what it establishes.

**It proves the reads happened.** Every recorded check must be backed by a read
tool that actually executed in that investigation, and one execution backs one
check. An agent cannot satisfy the gate by describing queries it never ran, and
cannot run one query and write up five findings from it.

**It proves the shape of the reasoning.** At least two independent signal
types, at least one competing explanation recorded as ruled out, an explicit
time window or affected scope, a named validation method, and a repair target
consistent with the proven cause.

**It does not prove the stated result is what came back.** The check records
what the agent says the query returned. That text is not currently compared
against the raw tool output. An agent that ran a real query and then
mis-summarised it would pass.

Closing that gap means retaining raw tool output and diffing it against the
recorded result, which is the next piece of work here. Until then: the gate is
a strong filter against unfounded conclusions and fabricated work, and a weak
one against honest misreading. Treat a `passed` gate as "this was investigated
properly", not as "this conclusion is certainly true" — which is also why a
plan derived from it still requires human approval.

## Auto-approval, and how to turn it off

Background agents have `readOnlyAgentBypass`, which skips the confirmation card
for commands classified read-safe. It never applies to `critical` commands, and
it respects explicit `ask`/`block` policy.

It still relies on the same text-based classification. **If your control
environment requires a human decision for every agent-initiated command,
disable it.** Interactive chat always shows the confirmation card for anything
mutating regardless of this setting.

## Prompt injection is an open surface

Content retrieved from your observability backends — log lines, alert
annotations, Kubernetes object descriptions — enters the model's context. That
content can be attacker-influenced, and the model can propose commands.

There is no filter that reliably separates "data the agent read" from
"instructions the agent should follow". What stands between a poisoned log line
and a production change is the approval step and the namespace/verb allowlist,
not the model's judgement.

Practical implications:

- Keep approvals human for anything that writes.
- Scope connectors to the namespaces the agent actually needs. A connector with
  no namespace restriction is a connector with no namespace protection.
- Leave `clusterShell` disabled unless you specifically want the agent to
  install charts and operators. Enabling it binds a ServiceAccount to
  `cluster-admin`.

## Reducing blast radius

In rough order of effectiveness:

1. **Restrict connector namespaces.** The allowlist is only as tight as the
   connector, and this control is structural rather than text-based.
2. **Keep `clusterShell` off** unless needed; if needed, set
   `clusterShell.clusterRole` to a role narrower than `cluster-admin`.
3. **Disable `readOnlyAgentBypass`** if every command must be human-approved.
4. **Use a scoped kubeconfig.** The credentials in the connector are the real
   ceiling — everything above is application-level. A kubeconfig that cannot
   delete cannot be talked into deleting.
5. **Ship audit rows to your SIEM.** They live in the application database and
   are not tamper-evident where they are.

## Reporting a bypass

If you find a command shape that reaches execution when it should not, that is
a security issue and we want it. Both of the bypasses documented above came
from someone deliberately trying to get past the gate, which remains the only
reliable way to find the next one.

## Related

- [Change control & audit](../compliance/change-control.md) — the evidence trail
  a change leaves
- [Auto-remediation](../operations/auto-remediation.md) — the alert-to-change pipeline
- [Authentication & RBAC](../auth.md)
