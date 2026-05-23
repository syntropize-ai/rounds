# Ops Trust Model

Status: **Draft for review (V5 — simplified Claude-style permissions)**
Owner: TBD
Last updated: 2026-05-20

This document replaces the current policy machinery (`connector_team_policies`
table, `humanPolicy`/`agentPolicy` enums, per-capability per-team grid,
`KUBERNETES_DEFAULT_POLICIES` seed, `ConnectorPoliciesDialog`). The current
machinery makes users configure whether actions are allowed, suggested,
confirmed, or formally approved. That is too much product surface for the
job.

The target model is deliberately closer to Claude Code:

1. Permissions decide whether the user can do the thing.
2. Confirmations decide whether the user wants to do this write now.
3. Formal approvals exist only for background alert remediation.

There is no per-connector "approval policy" for interactive chat. A user
with permission can run the action after a yes/no confirmation. A user
without permission is refused. The system does not create a plan so someone
else can approve a direct user request.

---

## 1. Glossary

| Term | Meaning |
|---|---|
| **Connector** | A `connectors` row (`type='kubernetes'`). Carries kubeconfig (inline or `secretRef`), allowed namespaces, optional cluster labels. |
| **Operator** | A human user authenticated to Rounds who can drive an ops action. |
| **Interactive context** | The originating request carries a live chat session ID. A human is present and can confirm or cancel the action. |
| **Autonomous context** | The originating request comes from a background runner, specifically alert-triggered investigation/remediation. No human is in the conversation. |
| **Tier** | Runtime-computed classification of an ops action: `read`, `patch`, `destroy`. Picks the gate UX. |
| **Danger surface** | A small set of always-elevated rules that override the verb-based tier (e.g. anything in `kube-system` is `destroy` regardless of verb). |
| **Confirm card** | The yes/no surface for interactive writes. It is not an approval, does not create an `ApprovalRequest`, and does not require another user. |
| **Plan** | The formal approval artifact for alert-triggered autonomous remediation only (today's `RemediationPlan`). |

---

## 2. Principles

These are the load-bearing decisions. Everything else flows from these.

### 2.1 The kubeconfig's RBAC is the floor; the product adds a small ceiling

The product **does not** maintain a parallel permission system. If the
connector's kubeconfig cannot do something, the action is refused with the
real RBAC error — not "denied by policy."

But RBAC alone is not the whole story:

- Most installs use a `cluster-admin` kubeconfig because that's what the
  install instructions say.
- `kubectl auth can-i` answers RBAC, not admission webhooks (Kyverno,
  Gatekeeper, PSS) or quota.
- Helm, `cluster_shell` scripts, and bundle applies are not kubectl verbs.
- RBAC has no concept of "production cluster" vs "dev cluster."

So we add a **product-side danger surface** layer that elevates
classification above RBAC (§5). RBAC is the floor; the danger surface is
the ceiling.

### 2.2 Approval is only for alert-driven autonomous remediation

Formal approval means "a background agent found a fix while nobody was in
the chat, so a team member must approve before the system mutates the
cluster." That path is for alert remediation only.

Interactive chat never uses formal approval:

- Read action + permission: run immediately.
- Write action + permission: show a confirm card; run only if the user
  clicks yes.
- No permission: refuse. Do not create a plan, do not ask another person
  to approve, and do not downgrade the action into a suggestion.

The proposer and confirmer are the same user in interactive chat. That is
intentional. The confirm card is a safety pause, not an approval workflow.

### 2.3 Safety-critical fields are runtime-computed, not LLM-authored

The agent writes only the **narrative** parts of a confirm card (a one-line
human description, a reasoning sentence). The runtime computes everything
that determines whether the gate fires or what tier applies:

- `tier` (read | patch | destroy)
- `irreversible: bool`
- `destructive: bool`
- `blastRadius` (resource count, traffic estimate from `kubectl get`)
- `gitops_managed: bool`
- Webhook pre-flight result

Reason: LLMs hallucinate, are subject to prompt injection, and write
post-hoc rationalizations. A confirm card whose "reversibility" claim came
from the LLM is a security hole disguised as UX. If the agent's narrative
contradicts the runtime's classification, the runtime wins and the
contradicting sentence is rendered with a red ⚠.

### 2.4 The product must be more convenient than `kubectl`

If the agent's path requires more clicks than typing the command into a
terminal, operators will bypass it. Defaults are tuned for "this just
works," not for "this is maximally defensive." The audit of the current
state (an external review, summarized §11) showed a 3–5 click minimum for
operations the user could do in a single command at a shell. That is the
metric to beat.

---

## 3. State machine

There are exactly two execution states.

```
        ┌───────────────────────────────────────────────────┐
        │  Request arrives at api-gateway                   │
        │  carries: connectorId, argv (or script), context  │
        └────────────────────┬──────────────────────────────┘
                             │
                ┌────────────┴─────────────┐
                │                          │
       interactive context        autonomous context
       (chat session present)     (background runner)
                │                          │
                ▼                          ▼
       ┌────────────────┐         ┌─────────────────────┐
       │ check RBAC     │         │ Build plan record   │
       │ classify tier  │         │  with alert context,│
       │ check danger   │         │  evidence, steps,   │
       │ surface        │         │  status=pending     │
       │ read: run      │         └──────────┬──────────┘
       │ write: confirm │                    │
       │ deny: refuse   │                    ▼
       └────────┬───────┘            ┌────────────────────┐
                │                    │ Operator reviews,  │
                ▼                    │  approves, plan    │
       user clicks Yes               │  executes all      │
       → execute via                 │  approved steps    │
       adapter, record               │                   │
       result                        └────────────────────┘
```

**Mode is determined by request context, not by the agent.** A request
arriving from chat has a `sessionId`; the gate treats it as interactive.
A request arriving from the alert dispatcher has
`runnerOrigin: 'auto_investigation'`; the gate treats it as autonomous.
There is no `as: 'now' | 'plan'` knob for the model to pick.

**Interactive requests never become plans.** If the user asks "install
Istio" in chat and they have permission, the runtime renders a confirmation
card and executes after yes. If they do not have permission, the runtime
refuses. The agent must not create `remediation_plan_create` with
`investigationId: ""`.

---

## 4. Tier classifier

Given a request, the runtime computes a tier. The classifier is **offline,
deterministic, and never queries the cluster for classification purposes**
(it WILL query for diff/dry-run; those are display concerns).

### 4.1 Verb table

| Verb | Default tier |
|---|---|
| `get` `list` `describe` `logs` `events` `top` `auth can-i` | read |
| `scale` `set image` `patch` `label` `annotate` `rollout restart` `rollout undo` `cordon` `uncordon` | patch |
| `delete pod <name>` where name matches `*-<5+hex>-<5+hex>` (RS/Deployment hash pattern) | patch |
| `delete pod <name>` (any other name shape) | destroy |
| `delete deployment/sts/ds/svc/cm/secret` | destroy |
| `delete namespace` `delete pv` `delete crd` `delete clusterrole*` | destroy |
| `drain` `exec` `cp` | destroy |
| `apply` | see §4.3 |
| `cluster_shell` | patch or destroy based on script/adapter pre-flight; interactive still uses confirm |

### 4.2 Tier-0 "Simulate"

A new tier below `read`: `simulate`. Covers `--dry-run=server`, `kubectl
diff`, `helm template`, `kustomize build`, `auth can-i`. Never gated.
This is how the agent earns trust — it can show what an action would
do before asking to do it.

### 4.3 `apply` is special

Most agent ops are `kubectl apply` of a generated manifest. Blanket-classifying
apply as destroy kills the product (the V3 challenger's most cutting
critique). Instead:

1. Runtime runs `kubectl diff` or `--dry-run=server` against the manifest.
2. Inspect the diff:
   - Only field updates on existing resources of `safe kinds` (Deployment,
     StatefulSet, DaemonSet, Service, ConfigMap, Secret, HPA, Ingress,
     PDB, NetworkPolicy) → **patch**.
   - New top-level resources → **destroy** (unknown blast radius).
   - Any change touching RBAC (`ClusterRole*`, `Role*`), CRDs,
     Namespaces, MutatingWebhookConfiguration, ValidatingWebhookConfiguration,
     PodSecurity, or anything mounting `hostPath/hostNetwork/hostPID`, or
     setting `privileged: true`, or `serviceAccountName` overrides → **destroy**.
3. If dry-run fails (apiserver unreachable, admission webhook rejects),
   the card shows the failure inline rather than guessing. The user
   sees: "Cluster will reject this. Reason: <webhook name>: <reason>".
   No green-light fallback.

### 4.4 Resource-class color codes

When the action targets a namespace marked `rounds.io/env=prod`, OR
the connector is marked production via the same label, the card is
rendered with a red header and the runtime forces typed-cluster-name
on every destroy action (even with active "don't ask again"
suppressions). Yellow for `staging`, green for `dev`. Missing label
defaults to **prod** (fail-closed; §5.3).

---

## 5. Danger surface

These are runtime overrides that elevate the tier above what the verb
table alone would say. The danger surface is a small, hand-curated set
of rules — not a configurable matrix — that closes the gap between RBAC
truth and operator intent.

### 5.1 Always-destroy namespaces

Regardless of verb, any action targeting these namespaces is `destroy`:

- `kube-system`
- `kube-public`
- `kube-node-lease`
- The Rounds install namespace (auto-detected from in-cluster service
  account, falls back to `rounds-system`)
- Anything labeled `rounds.io/protected=true` on the namespace itself

### 5.2 Always-destroy resource patterns

- `delete persistentvolume` with reclaim policy `Delete` (runtime checks
  `.spec.persistentVolumeReclaimPolicy` before classifying)
- `delete namespace` (any)
- `delete customresourcedefinition`
- Any patch removing a finalizer (`-p '{"metadata":{"finalizers":null}}'`
  shape)
- `cluster_shell` scripts with cluster-scoped effects

### 5.3 Production by default

Namespaces are treated as **production** unless they carry the cluster
label `rounds.io/env=nonprod` or `rounds.io/env=dev` or
`rounds.io/env=staging`. Operators opt out of production-class treatment
by labeling; we do not opt in. This is the inversion the V2 challenger
demanded — config-file globs that silently fail to match new namespaces
are not safe.

### 5.4 GitOps-managed warning

If the target resource carries
`app.kubernetes.io/managed-by=argocd|flux|helm`, the confirm card adds
a yellow banner: "This is managed by <controller>. Manual changes may
be reverted by the next reconciliation. Edit the source instead."
Does not block — controllers in the field have legitimate hot-fix
scenarios — but flags loudly.

---

## 6. cluster_shell

`cluster_shell` is powerful, but it is still an interactive action when it
originates from chat. It must not be forced into formal approval simply
because the command is not kubectl-shaped.

### 6.1 Interactive behavior

For chat-originated requests such as "install Istio" or "helm install
kube-prometheus-stack":

1. The agent calls `ops_cluster_shell` directly, not
   `remediation_plan_create`.
2. The runtime checks whether the user can operate the target connector.
3. The runtime creates a pending confirmation with the full script preview.
4. Execute only after the same user clicks yes.

If permission is missing, refuse. Do not create a remediation plan.

### 6.2 Autonomous behavior

For alert-triggered background remediation, `cluster_shell` steps are stored
inside a remediation plan. The plan record carries:

- Full script body (script preview UI required; no JSON-blob review)
- Job spec (image, namespace, ServiceAccount, timeout)
- Originating alert, investigation, and background-agent trace
- Agent's reasoning chain (LLM narrative, supplementary)
- Static analysis result: greps for `kubectl`/`helm` verbs, classifies each,
  reports the MAX tier as the script's tier (informational)

### 6.3 Execution

Unchanged from current `ClusterShellExecutionAdapter`: spawn a one-shot
Job in the cluster, watch for completion, fetch logs. The Job runs as
the `rounds-bootstrap` ServiceAccount (provisioned by the helm chart).

---

## 7. No two-person interactive mode

Two-person approval is out of scope for this product model. If a customer
needs separation of duties, that should be encoded in Kubernetes RBAC,
GitOps, or an external change-management system. Rounds' interactive agent
surface remains:

- allowed read: run
- allowed write: confirm then run
- denied: refuse

Adding a second-person approval mode to chat would reintroduce the same
complexity this document removes.

---

## 8. Confirm card

The single confirmation UI surface for interactive writes. It replaces
formal approvals, proposal queues, and per-connector approval settings in
chat. It is a yes/no prompt for the user who initiated the action.

### 8.1 Mandatory fields

| Section | Source | Notes |
|---|---|---|
| Cluster | runtime | Top-left, env-class colored (red/yellow/green) |
| Tier badge | runtime | "Patch" / "Destroy" / colored |
| Command verbatim | runtime | Monospace, full argv or full script for cluster_shell |
| Human description | **agent** | ~1 sentence, tool schema required |
| Reasoning | **agent** | Why this fixes the issue (~1 sentence) |
| Blast radius | runtime | Live cluster counts: "Affects 3 pods, ~3000 req/s" |
| Reversibility | runtime | "Reversible: scale back to 3" OR red "NOT REVERSIBLE" badge |
| Diff (apply only) | runtime | `kubectl diff` output, structured for create vs update |
| Risk summary (creates only) | runtime | Privileged / hostPath / hostNetwork / capability flags / SA override |
| Webhook pre-flight | runtime | If dry-run rejected: "Cluster will reject: <reason>". Blocks Run button. |
| Secrets | runtime | Detected in argv (`--from-literal`, `--token`, etc.) → redacted to `<redacted>` everywhere |
| Buttons | runtime | `[ Yes, run ]` `[ No, cancel ]` |

### 8.2 Destroy variant

The `[ Yes, run ]` button is gated by an input pre-filled `type "<resource-name>" to confirm`. For prod-class clusters, also requires typed cluster shortname above it. The card layout is the same — no separate modal.

### 8.3 Bulk variant

For actions touching N>1 resources (mass delete, batch patch). Single
card with enumerated, scrollable list. Per-row tier classification
shown. Confirm requires typed count (`type 47 to confirm 47 deletes`).

### 8.4 Multi-step interactive variant

For multi-step chat actions, all steps are listed in one scroll. Each row
has its own tier badge. A single `[ Yes, run all ]` button confirms the
whole batch. This still does not create a plan or an `ApprovalRequest`.

### 8.5 Idempotency

Confirmations carry server-side UUID + idempotency key derived from
(action signature, session ID, user ID). Reload re-fetches state.
States: `pending` / `executing` / `settled`. Safe to retry POST.

---

## 9. Refusal card

Every refusal carries four mandatory elements:

1. **What was attempted** (the actual command, not a tool name)
2. **Why it was refused** (RBAC error message OR danger-surface rule
   name, never "policy.deny")
3. **Who can do this** (role name OR list of users with appropriate
   RBAC — but "who is online" is NOT computed in v1; the card lists
   role holders, not presence)
4. **Action buttons** that do not bypass permission: `[ Cancel ]`

Sample:

```
✋ Can't run this

  kubectl delete deploy/payments -n prod

  Why: this kubeconfig (svc-account/rounds) doesn't have
       delete rights on deployments in prod
  Who: users with role ClusterAdmin can run this
  
  [ Cancel ]
```

The agent's prompt rule: relay refusals plainly, **do not retry the same
action**, **do not tell the user to run kubectl locally**, and **do not
create a plan to route around the user's missing permission**.

---

## 10. Undo

First-class undo for **truly reversible** actions.

### 10.1 Classification

The runtime classifies executed actions into three undo classes:

| Class | Examples | Chip |
|---|---|---|
| `truly_reversible` | scale, set image, label, annotate, cordon, rollout undo | Shown |
| `partial` | apply with prior manifest stashed, patch with diff stashed | Shown with caveat |
| `irreversible` | delete, drain (kind of), exec, anything destroying state | Hidden; card pre-flags "NO UNDO" |

### 10.2 Storage

Every executed action records an inverse template at execute time:
`{ undo_class, inverse_argv, inverse_diff_stash }` in a
`recent_reversibles` table (or the existing action audit row,
serialized).

### 10.3 Chip

Chat header shows "Undo last action" chip after a `truly_reversible`
or `partial` action completes. Clicking it generates an undo confirm
card with the inverse argv pre-filled. Same gate as a normal action.

---

## 11. Migration from current schema

### 11.1 What goes away

**Database:**

- DROP TABLE `connector_team_policies`
- DROP columns from `connectors`: none (config blob retained for other
  fields)

**Code:**

- `packages/api-gateway/src/services/ops-command-runner.ts`
  - `kubectlVerbToCapability()` — 17 capabilities collapse into the
    classifier (§4). The function is replaced.
  - `resolveEffectivePolicy()` — gone.
  - `PERMISSIVENESS_RANK` — gone.
- `packages/common/src/models/connector-template.ts`
  - `KUBERNETES_DEFAULT_POLICIES` — gone.
  - `KNOWN_KUBERNETES_CAPABILITIES` — gone.
- `packages/api-gateway/src/app/connectors-backfill.ts`
  - `backfillKubernetesPolicyDefaults()` — gone.
- `packages/web/src/components/ConnectorPoliciesDialog.tsx` — gone.
- `packages/api-gateway/src/routes/connectors.ts`
  - Policy CRUD routes (POST/GET/DELETE `/policies`) — gone.
- `packages/agent-core/src/agent/orchestrator-prompt.ts`
  - The "Ad-hoc write requests: propose a plan…" section — gone.
    Replaced with: direct chat writes use confirm cards; background
    alert remediation uses plans; denied actions are refused.

**Tool schema:**

- `ops_run_command` intent parameter collapses to: `argv`, `reason`,
  and the agent-narrative fields `humanDescription`, `reasoning`.
- `remediation_plan_create` is removed from the normal chat agent tool
  surface. It is available only to the background alert-remediation
  runner.
- `investigationId: ""` direct-request plans are deleted.

### 11.2 What replaces it

**Database:**

- New table `recent_reversibles` (or column on existing audit row):
  inverse template per executed action.
- No new policy table.

**Code:**

- New module `packages/common/src/ops/tier-classifier.ts`: pure
  function `classify(req) → { tier, irreversible, destructive,
  blastRadius, dangerSurface, gitopsManaged }`. Unit-tested with the
  verb table + danger surface rules.
- New module `packages/adapters/src/execution/pre-flight.ts`: wraps
  the kubectl adapter with `auth can-i` + `--dry-run=server` calls
  used to populate the confirm card.
- New runtime route `POST /api/ops/preflight` that returns a confirm
  card payload given an `(argv, connectorId)` pair. The web client
  calls this immediately before rendering the card; the agent's tool
  call also invokes it server-side before returning to the user.
- Plan executor changes to "approve means run all approved steps."
  Per-step approvals and the default `autoEdit=false` pause are removed.

**Cluster labels (operator-owned):**

- `rounds.io/env=prod|staging|dev|nonprod` (on namespaces or the cluster
  itself; namespace wins if both present)
- `rounds.io/protected=true` (on namespaces that should be destroy-only
  regardless)
- No `twoPersonApproval` connector flag.

### 11.3 Existing-customer migration safety

No backward compatibility is required for the old connector approval
matrix. Delete the policy rows, remove the UI, and rely on user/resource
permissions plus Kubernetes RBAC.

---

## 12. What's explicitly NOT in v5

- **Per-user role overrides.** v5 trusts the connector's kubeconfig to
  embody permission boundaries. Junior vs senior distinctions live in
  the kubeconfig (different SAs / RBAC), not in Rounds. The challenger
  argued for `operator`/`observer` per-connector roles — deferred to
  future work because it adds complexity without solving any concrete
  customer ask we have today.
- **Slack/mobile approval surface for direct chat.** Interactive requests
  do not create approvals.
- **Append-only audit file.** DB rows are the operational store. A
  signed append-only audit log is reserved as future work for
  compliance customers; v5 ships with DB-only audit.
- **Presence ("3 users online")** in refusal cards. v5 lists role
  holders, not who's currently online.

---

## 13. Open questions

1. **Bundle `kubectl apply -f` with mixed RBAC** — v5 says "refuse if
   any resource fails can-i" but doesn't specify the UI for explaining
   which ones failed. Needs a confirm-card variant that lists per-resource
   status. Design deferred.

2. **Helm operations** — v5 says "decompose to kubectl perms via `helm
   template` + can-i loop." This is non-trivial. May need a thin
   `HelmExecutionAdapter`. Decision deferred to when first Helm-heavy
   customer asks.

3. **Impersonation (`--as=user1`)** — v5 says "require explicit mapping
   at install, stamp both identities in audit." Mapping UI not
   designed. Defer to first customer using impersonation.

---

## 14. Phasing

This is the rough shipping order. Each phase is independently shippable
and improves the product on its own.

### Phase A — Kill the policy theater (highest impact, lowest risk)

- Delete `connector_team_policies` table + all the code referencing it
- Remove `KUBERNETES_DEFAULT_POLICIES` + `kubectlVerbToCapability()`
- Replace `resolveEffectivePolicy()` with a temporary "always allow"
  shim, so the existing kubectl adapter and plan executor keep working
- Remove `humanPolicy` / `agentPolicy` from connector configuration UI
- Result: agent can do anything the kubeconfig allows; no policy
  refusals. UX still has today's confirm modals. This alone unblocks
  the "the system is unusable" complaint.

### Phase B — Tier classifier + pre-flight

- Build `tier-classifier.ts` (§4) with the verb table and danger surface
- Build `pre-flight.ts` (§11.2) doing `auth can-i` + dry-run-server
- New API: `POST /api/ops/preflight`
- Result: every action knows its tier and gets a green/red light
  before executing.

### Phase C — New confirm card

- Implement the card UI (§8) with all mandatory fields
- Wire to pre-flight endpoint
- Add `humanDescription`/`reasoning` to `ops.run_command` tool schema
  (required fields)
- Remove `remediation_plan_create` from normal chat agents
- Result: the chat UI replaces today's approval/proposal surfaces with
  inline yes/no cards.

### Phase D — Cluster labels, danger surface, color coding

- Read `rounds.io/env=...` and `rounds.io/protected=true` at pre-flight
  time
- Card color coding for env class
- Force typed-cluster-name on prod-class destroys
- Result: prod gets visible friction without policy tuning.

### Phase E — Alert plan flow improvements

- Plan provenance fields (originating user msg, alert ID, tool trace)
- Plan approve executes all steps; remove default per-step approval pause
- Plan UI: list view + scroll-through approval for alert remediation
- Result: autonomous alert remediation becomes predictable: approve means
  run.

### Phase F — Undo + bulk + cluster_shell polish

- `recent_reversibles` storage + chip
- Bulk variant of confirm card
- Rich script diff/preview for cluster_shell confirm cards and alert plans

### Phase G — Helm support + future work

- HelmExecutionAdapter if/when needed
- Alert approval notification integration if customers want it
- Append-only audit log if compliance customers ask

---

## 15. Test plan

### 15.1 Unit

- `tier-classifier.ts` — every verb in the table classified correctly,
  every danger-surface rule fires, every apply-diff shape lands on the
  right tier
- `pre-flight.ts` — can-i success/failure paths, dry-run rejection
  rendering, webhook side-effect opt-out

### 15.2 Integration

- E2E: agent → ops.run with required fields → pre-flight → confirm card
  rendered → user clicks Run → adapter executes → audit row written
- E2E: same but pre-flight fails RBAC → refusal card → no plan or
  approval route offered
- E2E: alert fires → background investigation → plan created → team
  approves → executor runs all steps

### 15.3 Regression

- The 26 existing `ops-command-runner.test.ts` assertions about
  "deny/suggest/formal_approval observations" — these get rewritten or
  deleted as part of Phase A; the new contract is "kubectl error
  surfaces directly."

---

## Appendix A — Audit findings that motivated this redesign

(Summary of the four-agent audit run that preceded this doc.)

- **Default policy table is risk-averse to a fault.** Every write verb
  is `formal_approval`. `scale` and `delete namespace` are peers in the
  policy table — a calibration miss.
- **Solo dev installing on kind hits "denied by policy" on `kubectl
  scale`** despite pasting their own kubeconfig moments earlier.
- **The `allowedNamespaces` gate has no UI** — users hit "namespace not
  in allowlist" walls and can't find the setting.
- **The orchestrator prompt has `NEVER NEVER` warnings** because the
  policy gate tells the agent to propose plans and the LLM sometimes
  bails to "tell the user to run kubectl locally" instead. The system
  is fighting itself.
- **Plan-level approvals don't carry step content** in the action row;
  approvers see "Plan: bump replicas (1 step)" and approve blind.
- **`cluster_shell` has zero web UI** — approvers approve a JSON blob.
- **Empty policy table on a fresh connector falls back to deny.**

## Appendix B — Competitive research summary

- **Claude Code:** ask-once, remember, scope to file. Allowlist is a
  grep-able file. Strong UX win for single-user tools.
- **Argo CD:** opt-in automation per Application. Sync Windows for
  time-based gating. Configuration sprawl is the failure mode.
- **Flux:** no UI; PR review is the approval surface. Single source of
  truth (Git). Heavy for non-Git-native operators.
- **GitHub Actions Environments:** gate by deployment target, not by
  action. Required reviewers per environment. Wait timers. Inline
  approval UX in the run page.
- **k9s:** maximum speed, treats all deletes the same. Acknowledged
  footgun (issue #1016 — "make namespace delete harder").
- **Kyverno/OPA Gatekeeper:** policy as code. Same gate applies to UI,
  CI, and rogue scripts. Bad UX when blocked, but invariants belong in
  code.
- **Datadog Workflow Automation:** Slack approval per workflow step.
  Per-execution, not per-target.
- **PagerDuty Process Automation:** strong RBAC + audit, weak native
  approval. Customers bolt on ticketing systems.

The synthesis from this body of work that drove v5:

1. Gate the noun (resource/namespace/cluster), not the verb.
2. Two named modes (interactive/autonomous), not a slider.
3. Interactive writes use confirmation; alert remediation uses approval.
4. Defaults must be empirically correct, not maximally defensive.
5. Audit by construction; user-tuned matrices rot.
