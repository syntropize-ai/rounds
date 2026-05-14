# ADR-001: Repository pattern is canonical; stores become in-memory test fixtures

## Status

**Accepted** (Option C).

## Context

`packages/data-layer/src/` contains two overlapping persistence abstractions
covering the same domain entities:

- **Stores** (older): `packages/data-layer/src/stores/*.ts` — synchronous,
  in-memory, JSON-serializable (`Persistable` interface with `toJSON`/
  `loadJSON`). Marked dirty via a process-global `markDirty()` callback
  (`packages/data-layer/src/stores/persistence.ts:18-25`) so a separate snapshot
  flusher can persist them.
- **Repositories** (newer): `packages/data-layer/src/repository/{sqlite,postgres}/*.ts` —
  async, backed by Drizzle on SQLite or `pg` on Postgres, plumbed through
  `Persistence` (`packages/api-gateway/src/app/persistence.ts:82-205`). Shared
  interfaces are partly defined in
  `packages/data-layer/src/repository/interfaces.ts` and partly in
  `packages/common/src/repositories/{alert-rule,dashboard,investigation,auth,instance}/`.

PR-B added the `source` / `provenance` columns for write-source tracking to
**both** abstractions for dashboards
(`packages/data-layer/src/stores/dashboard-store.ts:30-52`,
`packages/data-layer/src/repository/sqlite/dashboard.ts:73-179`) and alert rules
(`packages/data-layer/src/stores/alert-rule-store.ts:38-39`,
`packages/data-layer/src/repository/sqlite/alert-rule.ts:74-272`). Every new
domain field today costs two implementations and two test sets. This is the
trigger for this ADR.

## Inventory

| Domain | Store file | Repository (sqlite/postgres) | Common interface | Production caller | Tests | Notes |
|--------|------------|-------------------------------|------------------|-------------------|-------|-------|
| Investigation | `stores/investigation-store.ts` (27 methods) | `repository/sqlite/investigation.ts` (37), `repository/postgres/investigation.ts` | `common/repositories/investigation/interfaces.ts` + `repository/interfaces.ts` | Repo only (`api-gateway/src/app/domain-routes.ts:168-184`) | Both: `stores/__tests__/investigation-store.test.ts`, `repository/sqlite/investigation.test.ts` | Repo has 10 more methods (archive/restore, findByWorkspace, findBySession, count). |
| Incident | `stores/incident-store.ts` (13) | `repository/sqlite/incident.ts` (17) | none (shape only) | Repo only (`domain-routes.ts`) | Repo only | Repo adds `findByService`, `findByWorkspace`, `archive`, `restore`. |
| Feed (rich `FeedItem`) | `stores/feed-store.ts` (12) | `repository/sqlite/feed.ts` (11) | none | Repo only, wrapped by `EventEmittingFeedRepository` (`server.ts`, `domain-routes.ts:163`) | Both | Store has subscribe/EventEmitter; repo gets that via wrapper in `repository/event-wrappers/feed.ts`. |
| Approval | `stores/approval-store.ts` (8) | `repository/sqlite/approval.ts` (9) + `postgres/approval.ts` | `repository/interfaces.ts:196-223` (IApprovalRequestRepository) | Repo only, wrapped by `EventEmittingApprovalRepository` (`domain-routes.ts:164`) | Both: `stores/.../approval.test`-ish + `repository/sqlite/approval.test.ts` | **Divergence: repo has org-scoped `list(orgId, opts)` with scope filter for multi-team RBAC (`repository/interfaces.ts:215-219`); store has no equivalent.** |
| Share (ShareLink) | `stores/share-store.ts` (6) | `repository/sqlite/share.ts` (4) + postgres | `repository/interfaces.ts:227-245` (two flavors: `IShareRepository`, `IShareLinkRepository`) | Repo only (`domain-routes.ts:171,175,180`) | Store-only | Repo lacks `clear()` (store-only test affordance). |
| Dashboard | `stores/dashboard-store.ts` (12) | `repository/sqlite/dashboard.ts` (15) + postgres | `common/repositories/dashboard/interfaces.ts` + `repository/interfaces.ts:261-286` | Repo only (`domain-routes.ts:211,218,247,255`) | Both: `stores/__tests__/dashboard-store.test.ts`, `repository/sqlite/dashboard.test.ts` | **Divergence: repo has `listByWorkspace`, `getFolderUid` (`sqlite/dashboard.ts:204,221`); store lacks both, so folder-scoped RBAC enforcement is unreachable through the store path.** |
| Folder | `stores/folder-store.ts` (8) | `repository/sqlite/folder.ts` (8) | `repository/interfaces.ts:290-298` | Auth FolderRepository (separate, in `repository/auth/folder-repository.ts`) wired via `rbacRepos.folders` | Store-only | Two folder repos exist (this one + the auth one); a separate ADR may need to reconcile that. |
| InvestigationReport | `stores/investigation-report-store.ts` (9) | `repository/sqlite/investigation-report.ts` (6) | `repository/interfaces.ts:402-408` | Repo only | Store-only | Store has 3 extra view helpers (`findByDashboard`, listing helpers). |
| PostMortem | `stores/post-mortem-store.ts` (3) | `repository/sqlite/post-mortem.ts` (4) | `repository/interfaces.ts:412-416` | Repo only | Store-only | Near-parity. |
| Version | `stores/version-store.ts` (5) | `repository/sqlite/version.ts` (5 effective) | `repository/interfaces.ts:380-393` | Repo only | Store-only | Parity. |
| Notification (contact points, policy tree, mute timings) | `stores/notification-store.ts` (31) | `repository/sqlite/notification.ts` (19) + `notification-channel.ts` + postgres | `repository/interfaces.ts:345-376` | Repo only (`domain-routes.ts` notifications wiring) | Both | Store has more helpers, repo has the canonical interface. |
| NotificationDispatch | `stores/notification-dispatch.ts` (1) | `repository/sqlite/notification-dispatch.ts` (8) | none | Repo only | Repo only | Store is essentially a stub. |
| AlertRule | `stores/alert-rule-store.ts` (34) | `repository/sqlite/alert-rule.ts` (21) + postgres | `common/repositories/alert-rule/interfaces.ts` + `repository/interfaces.ts:310-341` | Repo only, wrapped by `EventEmittingAlertRuleRepository` (`server.ts:199`) | Both: `stores/__tests__/alert-rule-store.test.ts`, `repository/sqlite/alert-rule.test.ts` | **Divergence: PR-B's `source`/`provenance` columns added to both (`stores/alert-rule-store.ts:38-39`, `sqlite/alert-rule.ts:74-272`). Repo has `getFolderUid` for RBAC (`sqlite/alert-rule.ts`); store does not.** |

### Wiring summary

- `packages/api-gateway/src/app/persistence.ts:153-204` — production boot path.
  Constructs `RepositoryBundle` via `createSqliteRepositories` /
  `createPostgresRepositories`. **No store is constructed in production.**
- `packages/api-gateway/src/server.ts:145-313` — references `persistence.repos.*`
  throughout. Wraps with `EventEmittingAlertRuleRepository` (`:199`),
  `EventEmittingFeedRepository` (`domain-routes.ts:163`),
  `EventEmittingApprovalRepository` (`:164`),
  `PublishingApprovalRepository` (`server.ts:214-215`).
- `packages/api-gateway/src/repositories/factory.ts` — declares
  `createInMemoryStores()` and `createDefaultStores()` that instantiate stores
  (lines 27-52). **No file imports this factory** (`grep` for
  `from.*repositories/factory` in `api-gateway/src` returns zero hits). It is
  dead code.
- Route files (`routes/dashboard/router.ts:29`, `routes/feed.ts:33`,
  `routes/approval.ts`, etc.) still declare their `deps.store` as
  `IGatewayDashboardStore` / `IGatewayFeedStore` (the interfaces in
  `stores/interfaces.ts`), but `domain-routes.ts` passes `repos.dashboards`
  there. Repositories satisfy the gateway interfaces by structural typing —
  the gateway-store interfaces are unfortunately-named contracts that have
  outlived the store implementations.

### Two concrete divergence cases (cited)

1. **Folder-scoped RBAC depends on a method that doesn't exist on stores.**
   `getFolderUid(orgId, id)` is declared on `IDashboardRepository`
   (`packages/data-layer/src/repository/interfaces.ts:285`) and
   `IAlertRuleRepository` (`:340`), implemented in
   `packages/data-layer/src/repository/sqlite/dashboard.ts:204` and
   `packages/data-layer/src/repository/sqlite/alert-rule.ts` (and Postgres
   counterparts). The store implementations
   (`packages/data-layer/src/stores/dashboard-store.ts`,
   `packages/data-layer/src/stores/alert-rule-store.ts`) do not implement it.
   A consumer wired to a store cannot enforce folder-level permissions.

2. **Multi-team approval scoping exists only on the repository.**
   `IApprovalRequestRepository.list(orgId, { scopeFilter, status })`
   (`packages/data-layer/src/repository/interfaces.ts:216-219`) is referenced
   by the approvals route for team-scoped views per
   `approvals-multi-team-scope §3.6`. `ApprovalStore` exposes only `listPending()`
   (`packages/data-layer/src/stores/approval-store.ts:82`). Two real
   capabilities of the system are unreachable through the store API.

Other field-level drift that confirms the trend:

- PR-B's `source`/`provenance` had to be added in four places (sqlite repo,
  postgres repo, sqlite store equivalent, and the store create method) —
  see the file:line refs in the Context section.
- `repository/sqlite/dashboard.ts:179` persists `provenance` as JSON; the
  store assigns it as a plain object reference — same field name, different
  storage contract, latent serialization risk if both paths ever ran.

## Decision

**Repositories are the canonical persistence abstraction. Stores remain only
as in-memory test fixtures and implement the same repository interfaces
(Option C).** All production wiring uses repositories. No new domain field
or method is added to a store going forward.

## Rationale

1. **Production already uses repositories exclusively.**
   `api-gateway/src/app/persistence.ts` constructs only repositories; `server.ts`
   and `domain-routes.ts` read only `persistence.repos.*` / `persistence.authRepos.*`
   / `persistence.rbacRepos.*`. The store factory at
   `packages/api-gateway/src/repositories/factory.ts` has no callers. Making
   repositories canonical ratifies the status quo rather than introducing
   change.

2. **Repositories carry capabilities stores can never have.**
   `getFolderUid`, `listByWorkspace`, org-scoped multi-team `list` with
   `ApprovalScopeFilter`, archive/restore semantics, count, server-side
   pagination — all live only on repositories
   (`repository/interfaces.ts:215, 275, 285, 313, 340`). These ride on SQL
   joins and indexes that an in-memory store can imitate but never match.
   Migrating those capabilities backward into stores would double the
   complexity without serving any real consumer.

3. **The dual-write tax is real and recurring.** PR-B paid it for `source`/
   `provenance` in dashboards and alert rules; every future field tracking
   feature (tenancy, soft-delete, audit cursors) faces the same multiplier
   unless one abstraction is retired.

4. **Stores still have a legitimate role as test substitutes.** Several test
   files (`stores/__tests__/*.test.ts`) exercise behaviour against an
   in-memory implementation without touching SQLite. Keeping stores alive as
   `InMemoryXxxRepository` (implementing `IXxxRepository`) preserves that
   ergonomic without the duplication cost — they become fixtures, not
   parallel implementations.

## Consequences

### What new code MUST do
- New domain entities or columns are added to repositories (sqlite + postgres)
  and their interfaces in `packages/data-layer/src/repository/interfaces.ts`
  or `packages/common/src/repositories/<domain>/interfaces.ts`. Stores do
  **not** receive new fields.
- Route handlers and services declare their dependency type as the repository
  interface (`IDashboardRepository`, `IAlertRuleRepository`, ...), not the
  gateway-store interface (`IGatewayDashboardStore`, ...).
- New gateway-level event wrappers go in
  `packages/data-layer/src/repository/event-wrappers/` next to the existing
  `feed.ts`, `approval.ts`, `alert-rule.ts`.

### What existing code is deprecated
- All concrete store classes in `packages/data-layer/src/stores/` for domains
  that have a repository (everything in the inventory above) are deprecated.
  They keep working until migrated. New imports outside of `__tests__/` are
  forbidden by the lint rule in the migration plan.
- The gateway-store interfaces in
  `packages/data-layer/src/stores/interfaces.ts` (`IGatewayDashboardStore`,
  `IGatewayFeedStore`, etc.) are deprecated. They will be either deleted or
  aliased to the corresponding repository interface in step M4 below.
- `packages/api-gateway/src/repositories/factory.ts` (orphaned) is deleted in
  M1.
- `markDirty()` / `Persistable` (`stores/persistence.ts`) are deprecated —
  repositories persist eagerly; the snapshot-flusher mechanism is unused once
  the last store consumer is gone.

### What CI/tests must change
- Add an ESLint rule (or import-restrict) that forbids `from
  '@agentic-obs/data-layer/stores'` and direct imports of store classes
  outside `packages/data-layer/src/stores/__tests__/` and
  `packages/data-layer/src/test-support/`.
- Tests that currently use a store as a substitute (none in production
  packages today, but a few in `agent-core`) switch to a repository-interface
  fake.
- The store unit tests (`stores/__tests__/*.test.ts`) stay until M5 (final
  removal), then go away along with the store implementations or get
  rewritten against `InMemoryXxxRepository` if that path is taken.

## Migration plan

Ordered, single-PR-sized steps. Sizes: S ≤ 1 day, M ≤ 3 days, L ≥ 1 week.

| # | Step | Files | Size |
|---|------|-------|------|
| M1 | Delete `packages/api-gateway/src/repositories/factory.ts` and `repositories/types.ts` (the gateway-store aggregate type). Verify nothing imports them. | 2 files | S |
| M2 | Re-type route deps: every `store: IGatewayXxxStore` in `routes/**/router.ts`, `routes/{feed,approval,meta,shared,notifications,alert-rules}.ts` becomes `IXxxRepository` from `repository/interfaces.ts`. Compile errors will be confined to the route boundary. | ~12 files | M |
| M3 | Add the import-restriction lint rule and a CI check failing on new `stores/<name>-store` imports outside the test-support allowlist. | `.eslintrc`, CI config | S |
| M4 | Decide: alias `IGatewayXxxStore = IXxxRepository` (cheap, keeps churn small) **or** delete the gateway-store interfaces and have routes use repository interfaces directly. Recommend the alias for M4 to keep the diff small; revisit deletion in M6. | `stores/interfaces.ts` | S |
| M5 | For each store with a repository peer (the entire inventory): either (a) delete the store and its `__tests__` if no fake is needed, or (b) rename to `InMemoryXxxRepository` implementing `IXxxRepository` and move under `packages/data-layer/src/test-support/in-memory/`. Per-domain PRs. | ~13 store files + 4 test files | L (cumulative; per-domain it is S/M) |
| M6 | Delete `stores/persistence.ts` (`markDirty`, `Persistable`) and any remaining snapshot flusher in api-gateway once M5 is complete. | 1-2 files | S |
| M7 | Update the data-layer top-level README and remove the `'@agentic-obs/data-layer/stores'` subpath export from `package.json`/`index.ts`. | 2 files | S |

**Total estimate: 2 × L equivalents, dominated by M5 (per-domain migration of
13 stores).** M1–M4 + M6–M7 together are ≈ 1 week of senior-engineer effort.

## Out of scope

This ADR does **not** decide:
- SQLite vs Postgres as the production default (that is T3.1).
- Whether the two folder repositories (`stores/folder-store.ts` +
  `repository/auth/folder-repository.ts`) should be unified — they overlap
  but the auth one is bound to the RBAC schema. Separate ADR.
- Reorganization of `packages/common/src/repositories/<domain>/interfaces.ts`
  vs `packages/data-layer/src/repository/interfaces.ts` (interfaces are split
  across two packages today). Mentioned in the code review but a separate
  cleanup.
- Event-wrapper strategy (currently three bespoke wrappers in
  `repository/event-wrappers/`). They continue to work as-is; whether to
  generalize to a single `EventEmittingRepository<T>` is a follow-up.

## Alternatives considered

**Option A — Repository canonical, stores fully deprecated and deleted, no
in-memory substitute.** Rejected because the four existing
`stores/__tests__/*.test.ts` suites and several `agent-core` integration tests
benefit from an in-memory persistence implementation. Deleting the stores
outright would force every test to spin up SQLite, which is feasible
(`test-support/test-db.ts` exists) but raises test-suite latency without
clear payoff. Option C subsumes Option A for everything except the test
fixture role.

**Option B — Store canonical, repositories deprecated.** Rejected on three
grounds: (1) production already runs on repositories, so this would reverse
working code; (2) repositories implement capabilities (`getFolderUid`,
multi-team `list`, archive/restore, pagination) that stores cannot replicate
without effectively becoming an in-memory SQL engine; (3) only repositories
have a Postgres implementation, and Postgres is the intended production
target per the existing `packages/data-layer/src/repository/postgres/`
build-out.
