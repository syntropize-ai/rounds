# Auto-Remediation Design

Status: **Draft for team handoff**
Owner: TBD
Last updated: 2026-04-29

End-to-end flow: a fired alert triggers an automatic investigation; if the
investigation can identify a fix that is in scope of an attached connector,
the agent emits a structured remediation plan; an authorized human approves
the plan; the plan is executed step by step (each step optionally requiring
its own approval).

This document is the source of truth for the work breakdown. Each phase has
a goal, an explicit task list (`T<phase>.<n>`), the files expected to be
touched, acceptance criteria, and dependencies. Phases are ordered for
shipping; tasks within a phase are independently parallelizable unless a
dependency is called out.

## 1. Glossary

| Term | Meaning |
|---|---|
| **Investigation** | The existing read-only diagnostic flow. Produces a `SavedInvestigationReport` with text + evidence panels. Unchanged in shape; refined in style (Phase 1) and gains cluster-read tools (Phase 2). |
| **RemediationPlan** | A new artifact: an ordered list of write actions the agent proposes to execute as a unit. Linked back to the investigation that produced it. The unit of human approval. |
| **PlanStep** | One write action inside a plan. Today only `ops.run_command` (kubectl shell). Future: `alert_rule.write`, `dashboard.update`, etc. |
| **RescuePlan** | Optional companion plan generated alongside the main plan, containing "undo" steps. Never auto-executes; only triggered by a human after a failure. Modeled as an ordinary plan with `rescue_for_plan_id` set. |
| **Auto-edit** | A flag set at plan-approval time. When true, the executor skips per-step approval and runs the whole approved plan. Scope: this plan only. Gated by `plans:auto_edit` permission. |
| **Connector** | An `ops_connectors` row, currently only `kubernetes`. Carries kubeconfig (via `secretRef`) + allowed namespaces + capabilities. |
| **Read-allow / write-allow / permanent-deny** | Three lists controlling which `kubectl` verbs are permitted in which context. See Phase 6. |

## 2. Architecture

```
                    ┌──────────────────────────┐
                    │  AlertEvaluatorService   │  Phase 0.5
                    │  (per-rule scheduler)    │
                    └──────────┬───────────────┘
                               │ alert.fired
                               ▼
              ┌────────────────────────────────┐
              │ AutoInvestigationDispatcher    │  Phase 8
              │ (service-account identity,     │
              │  read-only RBAC, dedup window) │
              └──────────┬─────────────────────┘
                         │
                         ▼
       ┌────────────────────────────────────────┐
       │ Investigation (existing flow,          │
       │   refined prompt — Phase 1)            │
       │   + ops.run_command(intent="read")     │  Phase 2
       │     → KubectlExecutionAdapter (read)   │  Phase 6
       └──────┬────────────────────────┬────────┘
              │ produces                │ optionally produces
              ▼                         ▼
    SavedInvestigationReport    RemediationPlan + (optional) RescuePlan
                                Phase 3 / Phase 4
                                          │
                                          ▼
                         ┌────────────────────────────┐
                         │ ApprovalRequest(kind=plan) │  reuses existing
                         └─────────┬──────────────────┘
                                   │ approve(autoEdit?)
                                   ▼
                         ┌────────────────────────────┐
                         │ PlanExecutorService        │  Phase 5
                         │  if autoEdit=false:        │
                         │    each step → per-step    │
                         │    ApprovalRequest         │
                         │  on failure: halt          │
                         └─────────┬──────────────────┘
                                   ▼
                         KubectlExecutionAdapter (write)  Phase 6
```

## 3. Phases

### Phase 1 — Investigation prompt de-templating

**Goal.** Investigation reports read like an engineer's debug notes, not a
filled-in template. Drop the hard-coded "Initial Assessment / Hypothesis /
Conclusion / Next Steps" structure.

| Task | Description | Files |
|---|---|---|
| T1.1 | Rewrite the "Investigation" section of the orchestrator system prompt: replace fixed section headings with do/don't guidance ("write like Slack to a teammate, allow detours, numbers inline, don't pre-name sections"). Keep the `add_section({type: text \| evidence})` API. | `packages/agent-core/src/agent/orchestrator-prompt.ts:136-177` |
| T1.2 | Update the example flow in the same file (lines ~160-177) so the example shows interleaved query → write → query, not write-everything-at-the-end. | same |
| T1.3 | Audit any existing unit/integration tests that assert on specific section titles (e.g. "Initial Assessment"); relax them. | grep `Initial Assessment\|Hypothesis Testing` under `packages/` |
| T1.4 | Manual review: run 5 representative investigations on a staging env, attach screenshots/text to PR. |  |

**Acceptance.** A produced report does not contain the literal headings
"Initial Assessment", "Hypothesis Testing", "Next Steps" unless the agent
chooses them. Tests pass. PR includes 3+ before/after sample outputs.

**Depends on.** None. Ship independently.

---

### Phase 0.5 — Periodic alert evaluator

**Goal.** Have alerts actually fire. Without this, "alert → auto-investigate"
is dead code. Single-leader, single-process; multi-replica HA is out of
scope (track in a follow-up).

| Task | Description | Files |
|---|---|---|
| T0.5.1 | Define `AlertEvaluatorService` interface + lifecycle (`start()`, `stop()`); register a leader lock row in `instance_settings` with periodic heartbeat; only the lock-holder evaluates. | new `packages/api-gateway/src/services/alert-evaluator-service.ts` |
| T0.5.2 | Per-rule scheduler: start a timer per active rule using `evaluationIntervalSec`; restart when rules are added/changed/deleted. | same |
| T0.5.3 | Evaluate one rule against its datasource via the existing `MetricsAdapter.query` / `MetricsAdapter.validateQuery`. Reuse what PR #28 added. | uses `packages/adapters/src/prometheus/metrics-adapter.ts` |
| T0.5.4 | State machine: `pending` (predicate true but not yet `forDurationSec`) → `firing` → `resolved`. Persist `last_evaluated_at`, `last_state` on the rule row (add columns, migrate). | schema + `alert-rule` repo |
| T0.5.5 | Append rows to `alert_history` on every state transition. | existing `alert_history` table |
| T0.5.6 | Emit an in-process `alert.fired` event (`EventEmitter`) on transitions to `firing`. Subscribers added in Phase 8. | same |
| T0.5.7 | Boot wiring: create the service in `server.ts::createApp` after persistence is ready; behind a feature flag `ALERT_EVALUATOR_ENABLED` (default true). | `packages/api-gateway/src/server.ts` |
| T0.5.8 | Tests: in-memory metrics adapter, fake clock, assert `pending → firing → resolved` transitions emit history rows + the event. | new `*.test.ts` |

**Acceptance.** Creating a rule with `condition.threshold > X` against a
canned metric source results in an `alert_history` `firing` row within
`evaluationIntervalSec + forDurationSec`. The lock prevents two simultaneous
evaluators from emitting duplicate firings (test by spawning two services
sharing one DB).

**Depends on.** None. Independent of Phases 1–7.

---

### Phase 3 — `RemediationPlan` data model

**Goal.** Persistent home for plans + steps. Independent of any agent or
executor logic; ship as a standalone schema migration with empty CRUD.

| Task | Description | Files |
|---|---|---|
| T3.1 | Define `RemediationPlan`, `RemediationPlanStep`, `RemediationPlanStatus`, `RemediationPlanStepStatus` types. | new `packages/common/src/models/remediation-plan.ts` |
| T3.2 | SQLite schema migration: tables `remediation_plan`, `remediation_plan_step` (columns per §3.x below). | `packages/data-layer/src/db/sqlite-schema.sql` + `sqlite-schema.ts` |
| T3.3 | Postgres schema migration: same tables. | `packages/data-layer/src/repository/postgres/schema.sql` + `db/schema.ts` |
| T3.4 | SQLite repository implementing `IRemediationPlanRepository`. | new `packages/data-layer/src/repository/sqlite/remediation-plan.ts` |
| T3.5 | Postgres repository (raw SQL via `pgAll`/`pgRun` to match the auth-repo pattern). | new `packages/data-layer/src/repository/postgres/remediation-plan.ts` |
| T3.6 | Wire into both factories + `repository/index.ts`. | `factory.ts`, `index.ts` |
| T3.7 | Unit tests: CRUD, list-by-investigation, list-by-status, expiry. |  |

**Schema (both backends):**

```sql
CREATE TABLE IF NOT EXISTS remediation_plan (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL,
  investigation_id   TEXT NOT NULL,
  rescue_for_plan_id TEXT,            -- NULL for primary plans
  summary            TEXT NOT NULL,
  status             TEXT NOT NULL,   -- draft|pending_approval|approved|rejected|executing|completed|failed|expired|cancelled
  auto_edit          INTEGER NOT NULL DEFAULT 0,
  approval_request_id TEXT,           -- FK to existing approval table
  created_by         TEXT NOT NULL,   -- 'agent' or userId
  created_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  resolved_at        TEXT,
  resolved_by        TEXT
);

CREATE INDEX idx_plan_org_status ON remediation_plan(org_id, status);
CREATE INDEX idx_plan_investigation ON remediation_plan(investigation_id);

CREATE TABLE IF NOT EXISTS remediation_plan_step (
  id                  TEXT PRIMARY KEY,
  plan_id             TEXT NOT NULL,
  ordinal             INTEGER NOT NULL,
  kind                TEXT NOT NULL,  -- 'ops.run_command' (others later)
  command_text        TEXT NOT NULL,  -- human-readable
  params_json         TEXT NOT NULL,  -- structured args for the executor
  dry_run_text        TEXT,           -- captured at plan creation
  risk_note           TEXT,
  continue_on_error   INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL,  -- pending|approved|executing|done|failed|skipped
  approval_request_id TEXT,
  executed_at         TEXT,
  output_text         TEXT,           -- truncated stdout
  error_text          TEXT,           -- truncated stderr
  UNIQUE(plan_id, ordinal)
);

CREATE INDEX idx_step_plan ON remediation_plan_step(plan_id);
```

**Acceptance.** Tables created via both `applySchema` and
`applyPostgresSchema`. Unit tests cover all CRUD operations. No agent or
HTTP-route code references the new types yet — purely a foundation layer.

**Depends on.** None. Ship independently from Phase 1.

---

### Phase 6 — Kubectl execution adapter + command allowlists

**Goal.** Real implementation of `ExecutionAdapter` that shells out to
`kubectl`. Read path is used by Phase 2 investigation; write path by Phase
5 plan executor.

| Task | Description | Files |
|---|---|---|
| T6.1 | `KubectlExecutionAdapter` implementing `ExecutionAdapter`. Uses Node `child_process.spawn` with `kubectl` argv (no shell metacharacters). | new `packages/adapters/src/execution/kubectl-adapter.ts` |
| T6.2 | KUBECONFIG handling: resolve `connector.secretRef` via `OpsSecretRefResolver`, write to a `mktemp` file with mode 0600 for the duration of the spawn, `unlink` in `finally`. Never log the kubeconfig contents. | same |
| T6.3 | Read-allowlist: verbs `get`, `describe`, `logs`, `top`, `events`, `version`, `api-resources`. Used in investigation context. | new `packages/adapters/src/execution/kubectl-allowlist.ts` |
| T6.4 | Write-allowlist (plan execution context only): `scale`, `rollout`, `patch`, `apply`, `annotate`, `label`, `delete <type> <name>`. | same |
| T6.5 | Permanent-deny list: `exec`, `cp`, `port-forward`, `proxy`, `attach`, `auth can-i --as`, any write targeting `kube-system` / `kube-public` / `kube-node-lease`. Permanent-deny wins over write-allow. | same |
| T6.6 | `dryRun(action)` runs `kubectl ... --dry-run=server -o yaml`, captures stdout into `step.dry_run_text`. | T6.1 |
| T6.7 | `validate(action)` preflight: parse argv, check verb in allowlist for the call site's mode (read vs write), check `--namespace` / `-n` is in `connector.allowed_namespaces`, reject if absent on a write. Surface errors as `ValidationError` (existing class). | T6.1 |
| T6.8 | Tests with mocked `child_process.spawn`. Cover happy-path, allowlist hit, permanent-deny hit, namespace mismatch, secret cleanup on throw. |  |
| T6.9 | Wire `KubectlExecutionAdapter` into the existing `OpsCommandRunner` + register in adapter registry. | `packages/agent-core/src/agent/handlers/ops.ts`, registry file |

**Acceptance.** A connector with `allowedNamespaces=['app']` plus a calling
mode of `read` allows `kubectl get pods -n app` but rejects
`kubectl get pods -n kube-system`, `kubectl exec ...`, and any
`kubectl apply ...`. KUBECONFIG temp file is unlinked in all exit paths.

**Depends on.** None for the adapter; T6.9 depends on existing
`OpsCommandRunner`.

---

### Phase 2 — Investigation auto-uses the connector (read-only)

**Goal.** When the org has a healthy `ops_connector` and the caller has
`ops:read` (or the auto-investigation service-account identity), the
investigation tool set automatically includes `ops.run_command(intent="read")`,
and the prompt nudges the model to inspect cluster state.

| Task | Description | Files |
|---|---|---|
| T2.1 | Helper `hasReadableOpsConnector(ctx)` and `getReadableConnectors(ctx)`. | `packages/agent-core/src/agent/handlers/_context.ts` |
| T2.2 | At investigation start, conditionally add `ops.run_command` to the active tool set with intent locked to `'read'`. | `packages/agent-core/src/agent/orchestrator-action-context.ts` |
| T2.3 | Tool gate: enforce that during investigation `intent !== 'read'` returns an error string from the handler before reaching the runner. | `packages/agent-core/src/agent/handlers/ops.ts` |
| T2.4 | Prompt addition (conditional on connector availability): listing connector name + namespaces + a short directive: "If the symptom is service-side, also check `pods`, `events`, recent `logs`. Don't apply changes from this turn." | `orchestrator-prompt.ts` |
| T2.5 | Use Phase 6's read-allowlist as the validate boundary. | depends on T6.3 |
| T2.6 | Tests: investigation with one connector mocked → assert ≥1 `ops.run_command(intent="read")` call hitting the allowlist. |  |

**Acceptance.** With one healthy `kubernetes` connector configured, an
investigation about a service issue calls `kubectl get pods` (or similar)
at least once; with no connector configured, the tool is not registered
and the prompt section is omitted. Investigation report still produced
unchanged.

**Depends on.** T6.3 (read-allowlist) for hard validation; can stub
allowlist locally to unblock work earlier.

---

### Phase 4 — Agent tools to create plans

**Goal.** Give the orchestrator a way to commit a structured plan + an
optional rescue plan after the investigation reaches a confident root cause.

| Task | Description | Files |
|---|---|---|
| T4.1 | `handleRemediationPlanCreate(ctx, args)`. Args: `investigationId`, `summary`, `steps[]`, `expiresInMs?`. Each step: `kind`, `commandText`, `paramsJson`, `dryRunText?`, `riskNote?`, `continueOnError?`. Validates each step against Phase 6 allowlists in dry-run-only mode (no execution); rejects plan if any step would be denied. Persists plan + steps. Creates a single `ApprovalRequest` with `action.type='plan'` and `context.planId` linking back. | new `packages/agent-core/src/agent/handlers/remediation-plan.ts` |
| T4.2 | `handleRemediationPlanCreateRescue(ctx, args)` — same shape, plus `rescueForPlanId`. Stored as a separate plan with `rescue_for_plan_id` set. **Does not** auto-create an ApprovalRequest; rescue plans are explicitly invoked from the UI after a failure. | same |
| T4.3 | Register both tools in `tool-schema-registry.ts` under category `always-on` for now. | `packages/agent-core/src/agent/tool-schema-registry.ts` |
| T4.4 | Prompt addition to investigation flow: "When the root cause is concrete and the fix is in scope of an attached connector, after `investigation.complete` you may emit `remediation_plan.create`. Do not run write commands from the investigation turn — only propose them in the plan." | `orchestrator-prompt.ts` |
| T4.5 | Per-step `dry_run_text` is populated by calling `KubectlExecutionAdapter.dryRun` once per step at plan-creation time. | depends on T6.6 |
| T4.6 | Tests: investigation + plan creation flow; assert plan persists with `pending_approval` status, ApprovalRequest exists, `dry_run_text` populated. |  |

**Acceptance.** End of an investigation that finds a fixable root cause:
exactly one plan row in `pending_approval`, exactly one matching
`ApprovalRequest`, every step has `dry_run_text` non-null. Bad plans (any
step would fail Phase 6 validation) are rejected with a clear error
returned to the model — no half-persisted plan.

**Depends on.** T3.* (model), T6.6 (dry-run), T6.7 (validate).

---

### Phase 5 — `PlanExecutorService` + plans REST + RBAC

**Goal.** End-to-end execution of an approved plan with halt-on-failure
semantics, optional auto-edit, and per-step retry.

| Task | Description | Files |
|---|---|---|
| T5.1 | `PlanExecutorService` with state machine: `approved → executing → (completed \| failed)`; consumes plan + steps from the repo. | new `packages/api-gateway/src/services/plan-executor-service.ts` |
| T5.2 | Per-step dispatch: if `plan.auto_edit=false`, create a step-level `ApprovalRequest` (`action.type='ops.run_command'`, `context.planId`, `context.stepOrdinal`) and pause; resume on approval via existing `approvalStore.onResolved`. | same |
| T5.3 | Step execution path: validate (Phase 6) → execute (Phase 6) → persist `output_text`/`error_text` (truncate to 64 KB) → update step status → emit audit_log. | same |
| T5.4 | Halt semantics: on step failure, mark plan `failed`, mark remaining steps `skipped`, do not auto-rollback; if step has `continue_on_error=true`, mark step `failed` but proceed. | same |
| T5.5 | Single-step retry API: `POST /api/plans/:id/steps/:ordinal/retry` re-runs that step only if its status is `failed`; resumes plan flow afterward. | new `packages/api-gateway/src/routes/plans.ts` |
| T5.6 | Plans REST routes: `GET /api/plans` (filter by status/investigation), `GET /api/plans/:id` (with steps), `POST /api/plans/:id/approve {autoEdit:bool}`, `POST /api/plans/:id/reject`, `POST /api/plans/:id/cancel`. | same |
| T5.7 | Mount router in `server.ts`; gate with auth + RBAC. | `packages/api-gateway/src/server.ts`, `app/domain-routes.ts` |
| T5.8 | New `ACTIONS`: `plans:read`, `plans:approve`, `plans:auto_edit`. Default RBAC seed: `plans:read`→Viewer+, `plans:approve`→Editor+, `plans:auto_edit`→**no default grant** (admin-only via explicit assignment, per user requirement that this be "given to a person or team"). | `packages/common/src/rbac/actions.ts`, `packages/data-layer/src/seed/rbac-seed.ts` |
| T5.9 | `PLAN_APPROVAL_TTL_MS` env var, default 24h; expiry job sweeps `pending_approval` plans and marks them `expired`. | service + scheduler tick |
| T5.10 | Tests: approve+auto_edit happy path; approve without auto_edit triggers per-step approvals; halt on failure; single-step retry; expiry. |  |

**Acceptance.** Full E2E test: create plan → approve(autoEdit=false) → step 1 emits ApprovalRequest → approve step 1 → step 1 executes → step 2 emits → reject step 2 → plan marked `failed`, step 3 `skipped`. Same scenario with `autoEdit=true` runs to completion without per-step approvals. Audit log has one row per step execution.

**Depends on.** T3.*, T6.*, T4.5 (so executor can re-validate steps it picks up).

---

### Phase 7 — Web UI

**Goal.** Operator surface for plan review + approval + retry.

| Task | Description | Files |
|---|---|---|
| T7.1 | Extend `ActionCenter`: tabs for `Plans` (pending), `Single actions` (existing pending), `Resolved`. | `packages/web/src/pages/ActionCenter.tsx` |
| T7.2 | New `PlanDetail` page at `/plans/:id`: summary, link to source investigation, ordered step list with `dry_run_text` previews, status pills, `Approve` button, `Reject` button, `Auto-edit subsequent steps` checkbox (rendered only if user has `plans:auto_edit`). | new `packages/web/src/pages/PlanDetail.tsx` |
| T7.3 | Permission gate: hide auto-edit checkbox unless `hasPermission('plans:auto_edit')`. Server-side route validates again — UI is purely cosmetic. | T7.2 |
| T7.4 | `InvestigationDetail` banner: when an investigation has a linked plan, show "Remediation plan ready → Review" link. | `packages/web/src/pages/InvestigationDetail.tsx` |
| T7.5 | Failed plans show a "Retry this step" button on `failed` rows; calls T5.5 endpoint. | T7.2 |
| T7.6 | If a rescue plan exists, show a "Run rescue plan" button on the failed plan; navigates to the rescue plan's PlanDetail. | T7.2 |
| T7.7 | API client wrappers in `packages/web/src/api/`. |  |
| T7.8 | RTL/Vitest component tests (existing patterns under `packages/web/src/**/*.test.tsx`). |  |

**Acceptance.** A user with `plans:approve` but not `plans:auto_edit` cannot see or send `auto_edit=true`. A user with neither can view but not approve. Failed-step retry round-trips successfully.

**Depends on.** T5.* (REST), T8.0 cosmetic (links from investigation work without it but are more useful with).

---

### Phase 8 — Wire alert.fired → auto investigation

**Goal.** Close the loop: a transition to `firing` automatically launches a
read-only investigation seeded with the alert's context.

| Task | Description | Files |
|---|---|---|
| T8.1 | `AutoInvestigationDispatcher`: subscribes to the in-process `alert.fired` event; produces an investigation goal text from rule name + condition + severity + offending sample value. | new `packages/api-gateway/src/services/auto-investigation-dispatcher.ts` |
| T8.2 | Auto-investigation identity: a synthetic service-account user (created by a one-shot seed migration) with grants only for read on metrics/logs/datasources/ops connectors. Cannot approve plans. | `packages/data-layer/src/seed/rbac-seed.ts` (extension) |
| T8.3 | Dedup window: same `ruleId` within `forDurationSec * 2` only spawns one investigation; tracked in a small in-memory LRU + DB column `last_auto_investigation_id` on the rule row. | T8.1 + schema migration |
| T8.4 | Pass alert metadata into the investigation as a tool-call observation (so the agent has the `query`, `threshold`, `value`, `labels` upfront). | `packages/agent-core/src/orchestrator/...` |
| T8.5 | Boot wiring: instantiate dispatcher in `server.ts` after persistence + alert evaluator are ready. | `packages/api-gateway/src/server.ts` |
| T8.6 | E2E test: synthesize a metric exceeding threshold → evaluator fires → dispatcher creates investigation → mock LLM returns plan → plan ends up in `pending_approval`. |  |

**Acceptance.** A single rule firing produces exactly one investigation in
the dedup window. The auto-investigation cannot create or approve plans;
it can only emit them. UI surfaces "auto-triggered by alert X" on the
investigation page.

**Depends on.** Phase 0.5 (event source), Phase 2 (investigation can use
connectors), Phase 4 (plan creation tool), Phase 5 (plan flow exists).

---

## 4. Cross-cutting

| Concern | Plan |
|---|---|
| **Feature flags** | `ALERT_EVALUATOR_ENABLED`, `AUTO_INVESTIGATION_ENABLED`, `PLAN_EXECUTION_ENABLED` (env vars, default true in dev/false in prod until each phase ships). |
| **Audit** | Every plan state transition + every step execution writes an `audit_log` row. Use existing `AuditWriter`. |
| **Observability** | Pino structured logs from each new service (`alert-evaluator`, `auto-investigation`, `plan-executor`). Add Prometheus-style counters (re-using existing pattern) for `alerts_evaluated_total`, `alerts_fired_total`, `auto_investigations_started_total`, `plans_created_total`, `plan_steps_executed_total{status}`. |
| **Secrets** | KUBECONFIG only resolved per-execution, written to `mktemp`-mode-0600, unlinked in `finally`. Never logged. Never persisted. |
| **Backout** | Each phase is reverse-mergeable: Phase 0.5 revert kills auto-fire (system reverts to manual investigation). Phase 5 revert leaves plans visible but un-executable. Phase 8 revert keeps alerts evaluating but no auto-investigation. |
| **Testing strategy** | Unit tests per service. Integration tests per phase (in-process). One end-to-end vitest covering Phases 0.5 + 2 + 4 + 5 + 8 with mocked datasource + mocked `kubectl` spawn. |
| **Rollout** | (1) ship Phase 1+3 silent. (2) ship Phase 6 (adapter exists, nothing calls write yet). (3) ship Phase 4+5 behind `PLAN_EXECUTION_ENABLED=false` in prod, dogfood internally. (4) enable Phase 0.5 and Phase 8 last, behind their flags. |

## 5. Out of scope (track in follow-ups)

- Multi-replica HA for the alert evaluator (single-leader is the v1).
- Connectors other than `kubernetes`.
- Step kinds other than `ops.run_command` (e.g. agent-driven `alert_rule.write` fixes inside a plan).
- Auto-rollback (deliberately not done — see §6 of the conversation transcript; aligns with AWS SSM `Abort` default and Ansible's halt-by-default semantics).
- Cross-cluster fan-out (one connector per plan in v1).
- Approval delegation / on-call rotations (use existing RBAC roles for now).

## 6. Open items requiring product/security input

| # | Item | Asked of |
|---|---|---|
| O1 | Service-account identity for auto-investigations: store with what login/email? Does it need a real password (no), or just a marker row? | Security review |
| O2 | Should `plans:auto_edit` be revocable per-plan-namespace (e.g. user can auto-edit `app` but not `kube-system`)? | Product |
| O3 | Maximum concurrent in-flight plans per org? | Product |
| O4 | Should rescue plans be auto-suggested by the agent or only generated on operator request? | Product |
| O5 | When auto-investigation finds nothing actionable, should it still post a report or stay quiet? | Product |

## 7. Rough sizing

| Phase | Est. eng-days | Risk |
|---|---|---|
| Phase 1 | 1–2 | Low (prompt only) |
| Phase 0.5 | 5–7 | Medium (single-leader correctness) |
| Phase 3 | 2–3 | Low |
| Phase 6 | 5–7 | Medium-high (security: KUBECONFIG handling) |
| Phase 2 | 2–3 | Low (depends on Phase 6) |
| Phase 4 | 3–4 | Medium |
| Phase 5 | 7–10 | High (executor state machine, RBAC) |
| Phase 7 | 5–7 | Low-medium |
| Phase 8 | 3–5 | Medium |
| **Total** | **33–48** | — |

## 8. Suggested team layout

| Stream | Phases | Skills |
|---|---|---|
| Platform / data | 0.5, 3, 5, 8 | Node services, SQL, RBAC |
| Adapter / shell | 6 | Node, kubectl, security review |
| Agent | 1, 2, 4 | Prompt engineering, agent-core |
| Frontend | 7 | React, RBAC-aware UI |

Streams can run in parallel after Phase 3 lands.
