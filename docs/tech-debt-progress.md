# Tech-debt cleanup — progress snapshot (2026-04-19)

Multi-wave cleanup driven by audit at [tech-debt-audit-plan.md](./tech-debt-audit-plan.md),
plus a follow-up sprint on permissions / UX surfaced by manual smoke test.

## User decisions (locked in)

- `instance_datasources.org_id` TEXT NULL — null = instance-global; no per-org logic in v1
- Credentials encrypt via existing `SECRET_KEY` / `@agentic-obs/common/crypto`
- **No migration code** — fresh build, no data, no users. Old `setup-config.json` deleted outright.
- Ship everything AGPL (no OSS/Enterprise split scaffolding)
- One orchestrator agent for every chat surface (specialized agents removed) — RBAC at Layer 3 does the per-user filtering, not per-page agent ceilings
- "Legacy 该删的就删" — no compatibility shims; rip out dead code on sight

## Status

- **53 commits ahead of `origin/main`**
- **Pushed to `origin/dev`** — PR-ready at <https://github.com/openobs/openobs/pull/new/dev>
- Workspace tests: **1037/1037 pass**
- `npx tsc --build` clean across all 8 packages

## Commit history (newest first, since the original doc)

### Backend RBAC cleanup (this evening)

- `dbdc154` — **Backend RBAC wave 2**: migrated chat / dashboard / feed / meta / notifications / investigation-reports / versions / webhooks routers + websocket gateway off the legacy string-based `requirePermission`. **Deleted `packages/api-gateway/src/middleware/rbac.ts`** entirely (BUILTIN_ROLES, RoleStore, hasPermission, legacyRoleFromIdentity all gone). Side-fix: feed mutating endpoints were under a Viewer-readable gate — now under `InvestigationsWrite`.
- `16284a8` — **Backend RBAC wave 1**: alert-rules / investigation / approval routes migrated off legacy strings; introduced canonical `instance.config:read/write` action; Settings LLM/Notifications/Reset stop using `datasources:write` as a hack.
- `71c0a46` — **Full frontend permission audit**: gated every mutating affordance (Alerts Disable/Delete, Dashboards "+New" / "+Folder", Investigations new/delete, ActionCenter approve/reject, DashboardWorkspace title-rename / move-folder / Permissions, per-panel hover edit/trash, Settings tabs, Admin Users delete). Also drops the legacy-string fallbacks left in earlier audit.
- `bfc4a21` — first slice of frontend gating: Settings nav + `/settings` route, Dashboard Edit / Add Panel / Delete buttons.
- `e718f5e` — `/api/datasources` granular per-action RBAC (was incorrectly on `dashboard:write`).

### Server-admin UX

- `28fc8a4` — Grafana-parity Server Admin org-edit page: `userCount` per org row, drill-down `/admin/orgs/:id` for cross-org member management without switching active org.

### Smoke-test bug fixes (rolling)

- `c9a690f` — RowActions menu in admin tables now portals to body so the dashboard's `overflow-x-auto` can't clip it.
- `5ee2cc3` — OrgSwitcher renders org names (added `name` to `/api/user` orgs[]).
- `232acab` — Team members drawer shows login/email/name (JOIN on user table).
- `8715e5b` — Admin → Users tab hides service accounts (default `is_service_account=false` filter).
- `28ffcb4` — `/api/orgs` + `/api/org/users` use the canonical `{ items, totalCount }` envelope (was bare arrays).
- `c9ead0d`, `2e20715`, `a4c1fa9` — agent `dashboard.create` / `investigation.create` / `create_alert_rule` now thread `workspaceId: ctx.identity.orgId` so the new row is reachable from the redirect.
- `d626a50` — setup routes use `bootstrapAware` instead of hard-closing post-bootstrap, so the wizard's LLM step works after admin creation.
- `f6cbe36` — collapse to single `orchestrator` agent, removing the 4 per-page specialized agents.
- `fe8b8ae` — global rate limit raised 100 → 600 req/min/IP (operator-tunable via `OPENOBS_RATE_LIMIT_MAX`).
- `1bb6a6c` — setup wizard duplicate-datasource bug, avatar menu popover, SetupGuard back-button trap.

### W4 deferred + W5 verify (earlier this sprint)

- `25e082d` — apikey-service tests assert new AppError shape (T4.1 fallout).
- `05efd4a` — silent swallows + legacy paths + dead code (T4.2 server / T4.3 / T4.4).
- `7943749`, `def3902`, `76c6616` — config-architecture.md, auth-login test fix, vitest pin to ^3.2.4.
- `156baea` — W4 partial (T4.1 error envelope + T4.2 web client).

(W1–W3 commits are documented in the original audit plan.)

---

## Architecture summary (where things live now)

- **Auth + RBAC**: Grafana-parity. SQLite `user` / `org` / `org_user` / `team` / `team_member` / `role` / `permission` / `user_role` / `team_role` / `builtin_role` (see migrations 001–017). Three-layer agent gate (allowedTools ∩ permissionMode ∩ RBAC) in `packages/agent-core/src/agent/permission-gate.ts`. Single canonical `requirePermission(ac)` middleware everywhere.
- **Instance config**: SQLite `instance_llm_config` / `instance_datasources` / `notification_channels` / `instance_settings` (migration 019). All secrets encrypted at rest via `@agentic-obs/common/crypto` + `SECRET_KEY`. Owned by `SetupConfigService`.
- **Setup wizard**: pre-bootstrap (`instance_settings.bootstrapped_at` IS NULL) → unauth on `bootstrapAware`-wrapped routes. Post-bootstrap → `authMiddleware` + per-action `requirePermission`.
- **Agent**: one `orchestrator`, full toolset; chat at every surface goes through it. Agent's tool calls run under the **caller's** identity, RBAC enforced per call.
- **Frontend**: every mutating affordance gated on `useAuth().hasPermission(action, scope?)`. Pages whose entire surface is write-only (Settings) wrapped in `PermissionGate`.

Reference: [docs/config-architecture.md](./config-architecture.md).

---

## Outstanding follow-ups (not done; here's the catalog)

### Architecture

- **Dashboard / Investigation / Alert-rule stores still in-memory**. Restart wipes all dashboards / investigations / alerts. SQLite tables exist for some (alert_rules has migration), but the `defaultDashboardStore` / `defaultInvestigationStore` adapters in `packages/data-layer/src/stores/` are still in-memory. Mirror what W2 did for instance config: move them into SQLite with proper repositories, retire the in-memory stores. Big task; treat as W6.
- **Per-user rate limiting**. Current `defaultRateLimiter` keys on IP. Behind a NAT (corporate LAN, K8s ingress) all users share one IP and hit the limit together. Add a layered limiter that keys on `req.auth.userId` post-auth, falling back to IP pre-auth.
- **Postgres adapter for instance-config repos**. Server.ts deletes the `DATABASE_URL` (Postgres) branch with a "throw at startup" because the new `InstanceConfigRepository` / `DatasourceRepository` / `NotificationChannelRepository` only have SQLite implementations. If we ever want Postgres back, port them.

### UX

- **Chat in-flight pre-check**. The agent attempts a tool, hits Layer-3 RBAC denial, narrates "I don't have permission" — that's correct, but a Viewer asking "delete X" still wastes one tool call. Could pre-filter the LLM prompt to say "you're operating as a Viewer; don't propose mutations" — but only a UX nicety, not a security one.
- **Settings tab refinement**. Current `SettingsGate` allows any of `datasources:write` / `datasources:create` / `admin:write`. If a user has `datasources:*` but not `instance.config:write`, they see all tabs but the LLM/Notifications tabs error on save. Fine for v1; revisit if we ever split datasource-admin from instance-admin roles.
- **PostMortem.tsx** is dead UI — backend route `/incidents/:id/post-mortem` doesn't exist. Either implement or delete the page + the nav entry.
- **Hover-reveal pattern** elsewhere — the `opacity-0 group-hover:opacity-100` was hiding mutation buttons in DashboardPanelCard before being properly gated. Audit the rest of the components for the same anti-pattern.

### Documentation

- `docs/auth-perm-design/11-agent-permissions.md` has a status note at the top after the single-agent collapse. Eventually rewrite the body for the post-rollback shape (it still describes the four specialized agents in detail).
- The original `docs/tech-debt-audit-plan.md` still describes the W4 scope as four tasks; it's effectively obsolete now (everything done). Could be marked as historical.

### Testing / CI

- Vitest is pinned to `^3.2.4` to compat with vite@5 (vitepress chain). When vitepress catches up to vite 6+, can unpin and try vitest 4 again.
- 5 pre-existing apikey-service tests had to be updated for the new `AppError` shape (`25e082d`). No more known pre-existing failures, but new integration tests should follow the established harness pattern (`createTestDb()`, real sqlite, no mocks).

### Workflow

- **Branching**: this sprint pushed to `origin/dev`. Open a PR to merge into `main` when ready. Don't push directly to main.
- **Sandbox quirk** for future sub-agents: `git commit` is denied inside agent sessions. Agents should stage + write the commit message to `.<task>-commit-msg.txt` at repo root; the parent commits on their behalf. This pattern is now the established convention for the sprint.

---

## Context handoff notes

- **Memory pointer**: `~/.claude/projects/c--Users-shiqi-Documents-openobs/memory/project_tech_debt_cleanup.md` — keep updated when waves complete.
- **Commit convention**: `TN.M:` per-task when independent; `WN:` for combined waves; descriptive subject otherwise. Footer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **Do not push to `main`** without explicit user approval. `dev` is the working branch.
