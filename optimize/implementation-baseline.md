# Task 00 — Implementation Baseline

Snapshot of the OpenObs monorepo as of branch `claude/hungry-mclaren-23796a`
(HEAD `139a47c`). Read-only inventory; no production code changed.

## 1. Per-workspace test/typecheck commands

All packages declare `vitest run` / `tsc --noEmit` except `cli`. Root scripts:
`npm run typecheck` (`tsc --noEmit -p tsconfig.json`) and `npm test`
(`vitest run`) drive the whole repo at once.

| package      | `npm --workspace <pkg> run test` | `... typecheck` |
|--------------|----------------------------------|-----------------|
| adapters     | `vitest run`                     | `tsc --noEmit`  |
| agent-core   | `vitest run`                     | `tsc --noEmit`  |
| api-gateway  | `vitest run`                     | `tsc --noEmit`  |
| cli          | **missing**                      | **missing**     |
| common       | `vitest run`                     | `tsc --noEmit`  |
| data-layer   | `vitest run`                     | `tsc --noEmit`  |
| guardrails   | `vitest run`                     | `tsc --noEmit`  |
| llm-gateway  | `vitest run`                     | `tsc --noEmit`  |
| web          | `vitest run`                     | `tsc --noEmit`  |

`packages/cli/package.json` has no `test` or `typecheck` scripts. CLI is built
via root `npm run dist` (`scripts/build-cli.mjs`) and is covered by the root
`tsc -b`, but it has no unit tests.

## 2. Status of roadmap items

| Item                                | Status            | Evidence |
|-------------------------------------|-------------------|----------|
| api-key-helper RCE                  | **already done**  | `packages/llm-gateway/src/api-key-helper.ts:78` still uses `execAsync(command)` on a free-form shell command, but it is operator-supplied config (not user input): `helperCommand` comes from `ApiKeyResolverOptions` set at gateway construction. Has 5-min TTL cache, 10s timeout, 1 MB output cap, in-flight coalescing. No remaining "user-supplied" surface. |
| ActionGuard wiring                  | **not started**   | `packages/guardrails/src/action-guard/action-guard.ts` exports `ActionGuard`; only re-exports in `packages/guardrails/src/index.ts:?` and `action-guard/index.ts`. Zero `new ActionGuard(` callers anywhere in `packages/` (`rg "new ActionGuard|ActionGuard\("` → empty). |
| query-client `user` regex hack      | **still present** | `packages/data-layer/src/db/query-client.ts:23-28` runs five `.replace(/\bFROM\s+user\b/gi, ...)`-style regexes after `query.toQuery(...)`. |
| LLM audit persistence               | **not started**   | `packages/llm-gateway/src/audit.ts:18` — `private entries: AuditEntry[] = []`. Pure in-memory, no DB writer, no flush. |
| Alert default folder                | **already done**  | Commit `c58b8a3`. `packages/agent-core/src/agent/handlers/alert.ts:31` `DEFAULT_ALERT_RULE_FOLDER_TITLE = 'Alerts'`. `packages/api-gateway/src/routes/alert-rules.ts:22-23` define UID/title; `:76-83` ensure-create the folder; `:126,:333` fall back to `DEFAULT_ALERT_RULE_FOLDER_UID` when no `folderUid` is provided. |
| Dashboard validation gate           | **already done**  | Commit `2b93592`. `packages/agent-core/src/agent/handlers/dashboard.ts:212-214` blocks `dashboard_add_panels` when any query is missing from `evidence.validatedQueries`, instructing the agent to call `metrics_validate` first. Tests: `dashboard.test.ts` (added in same commit). |
| Ops connector execution wiring      | **partially done**| Connector data model + service exist (`packages/data-layer/src/repository/.../ops-connector.*`, `packages/api-gateway/src/services/ops-connector-service.ts`). Execution adapter only for kubectl: `packages/adapters/src/execution/kubectl-adapter.ts:57` consumes `OpsConnector.allowedNamespaces`. No generic "ops connector → adapter" registry / dispatch layer found. |
| LLM streaming                       | **not started**   | `packages/llm-gateway/src/types.ts:99-104` — `LLMProvider` has only `complete()` and optional `listModels()`. No `stream()` or async-iterator method. |
| Cost tracking on LLM calls          | **not started**   | `rg "costUsd|cost_usd"` in `packages/` returns no hits. `LLMUsage` (`types.ts:69-73`) only carries token counts. |
| License: root vs cli                | **inconsistent**  | Root `LICENSE` is **MIT**, copyright "Prism contributors" (line 3). `packages/cli/package.json` declares `"license": "AGPL-3.0-or-later"`. Mismatch is real. |
| Prism branding leftovers            | **partially clean** | 8 files still mention `prism` (case-insensitive), excluding `node_modules`/`package-lock`: `packages/web/src/lib/data/{index,types}.ts`, `packages/web/src/lib/uplot/config-builder.ts`, `packages/web/src/components/viz/{TimeSeriesViz,GaugeViz,HeatmapViz}.tsx`, `packages/web/src/lib/theme/palette.ts`, `packages/web/src/lib/viz-sync/cursor-sync.ts`. All are comment/identifier mentions ("prism dark surface", "prism chart data layer"), not `prismjs` deps. Plus `LICENSE:3`. |
| promptHash truncation               | **still present** | `packages/llm-gateway/src/gateway.ts:101-104` — `createHash('sha256').update(...).digest('hex').slice(0, 16)`. 16 hex chars = 64 bits. |
| Gemini API key in URL query         | **still present** | `packages/llm-gateway/src/providers/gemini.ts:239` `…:generateContent?key=${this.apiKey}` and `:331` `…/v1beta/models?key=${this.apiKey}`. |
| Folder recursive delete txn         | **not started**   | `packages/data-layer/src/repository/postgres/folder.ts:65-73` and `sqlite/folder.ts:65-73`: `delete()` recurses via `findByParent` + `await this.delete(child.id)` followed by a final `db.delete(...)`. No `withTransaction` wrap; partial failure leaves orphans. |
| Approval-router N+1                 | **still present** | `packages/api-gateway/src/services/approval-router.ts:127-142` — nested `for (const roleId of matchingRoleIds) { await listByRole(...) }` and a second loop calling `listByTeam(teamId)` per team. One round-trip per role and per team. |
| ChatContext value stability         | **already done**  | `packages/web/src/contexts/ChatContext.tsx:8` passes `chat` from `useChat()` directly. The stability is provided one layer down: `packages/web/src/hooks/useChat.ts:602` returns via `useMemo(...)`, so the context value is referentially stable. No additional wrapper needed. |

## 3. Recently-landed work the roadmap might re-propose

- **`139a47c` fix(toolbar): rewrite TimeRangePicker + extract RefreshControl** — UI-only; no backend impact.
- **`353e454` refactor(viz): unified responsive panel layout** — replaces three sizing systems in `packages/web/src/components/viz/*` with one. Future "panel sizing" tasks are obsolete.
- **`2b93592` Enforce read-validate dashboard builds** — see roadmap "dashboard validation gate" → **done**. Skip rebuilding.
- **`c58b8a3` Default alert creation to Alerts folder** — see roadmap "alert default folder" → **done**. Skip.
- **`bb4fb03` OpenRouter / OpenAI-compatible harness for tool_search + web_search measurement** — bench/measurement scaffolding; not a product change. Don't re-scope.

## 4. Test / typecheck results

- `npm run typecheck` — **PASS** (no output, exit 0).
- `npm test` — **FAIL**: 29 failed / 1761 passed / 19 skipped across 4 files
  (170 files total).
  - `packages/api-gateway/src/routes/approval.test.ts`
  - `packages/api-gateway/src/services/approval-router.test.ts`
  - `packages/api-gateway/src/services/notification-consumer.test.ts`
  - `packages/api-gateway/src/services/plan-executor-service.test.ts`

  Failures concentrate on the multi-team approval-scope work
  (`requesterTeamId` returning `undefined` instead of `null`, candidate-scope
  builder, fail-closed routing). Both production paths and tests appear
  out-of-sync — likely a pending migration or an in-flight column rename.
  Failures are NOT related to most roadmap items below; only the
  "approval-router N+1" item shares this area.

  Per-workspace fallback: failures live entirely in `api-gateway`; other
  packages' suites are presumed green inside the root run.
