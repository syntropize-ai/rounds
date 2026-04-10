# Dashboard Scaffold TODO

## No-Metrics Dashboard Scaffolding

**Goal:** Support prebuilding dashboards before Prometheus metrics are available, without producing broken runtime behavior or contradictory chat flow.

**Why this matters:**
- Generating a dashboard scaffold without live metrics is a valid and useful workflow.
- The current behavior can ask for clarification about missing metrics while still leaving behind a generated dashboard, which feels inconsistent.
- Generated panels may reference variables like `$namespace`, `$service`, and `$method` even when the dashboard has no variables defined.
- The UI currently runs scaffold queries immediately, which surfaces raw `fetch failed` errors instead of a clearer "waiting for datasource/metric mapping" state.

**Follow-up work:**
1. `packages/agent-core/src/dashboard-agents/orchestrator-agent.ts`
- Prevent contradictory outcomes where `needsClarification` and a normal generated dashboard both persist in the same flow.
- Make the no-metrics path explicit: either stop and ask the user, or intentionally save a scaffold dashboard with matching metadata/state.

2. `packages/agent-core/src/dashboard-agents/dashboard-generator-agent.ts`
- In no-discovery mode, do not emit queries that reference template variables unless those variables are also emitted.
- Prefer stable scaffold queries or scaffold placeholders over half-bound PromQL.

3. `packages/web/src/pages/DashboardWorkspace.tsx`
- Add a friendlier scaffold/no-datasource presentation instead of rendering raw query failures for intentionally prebuilt dashboards.

4. Verification
- Cover:
  - no Prometheus datasource configured
  - Prometheus configured but no relevant metrics discovered
  - scaffold dashboard with variable references
  - clarification flow does not silently leave behind a broken dashboard
