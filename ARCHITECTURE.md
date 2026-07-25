# Architecture

Rounds is an open-source AI SRE: an LLM-driven agent that investigates incidents, builds dashboards, manages alert rules, and (with approval) remediates. Kubernetes is the first deep ops connector; Prometheus alerting rules, Loki routing, GitHub PR-based fixes, Jira / PagerDuty incident sync, CI/CD systems, and database read connectors are planned. It is structured as a TypeScript monorepo with 9 packages under `packages/`.

## Layer Diagram

```
                  +-----------+
                  |    web    |  React SPA (Vite)
                  +-----+-----+
                        |  HTTP / SSE / socket.io
                  +-----v------+
                  | api-gateway |  Express HTTP server
                  +-----+------+
                        |
          +-------------+-------------+
          |             |             |
    +-----v-----+ +-----v-----+ +-----v-----+
    | agent-core | | data-layer | | llm-gateway |
    +-----+-----+ +-----+-----+ +-----+-----+
          |             |             |
          +------+------+------+------+
                 |             |
           +-----v-----+ +-----v-------+
           |  adapters  | | server-utils |
           +-----+-----+ +-----+-------+
                 |             |
                 +------+------+
                        |
                  +-----v-----+
                  |  common   |
                  +-----------+

    cli — packaging only: esbuild-bundles api-gateway + web into
          the publishable `@syntropize/rounds` npm package.
```

## Package Responsibilities

| Package | npm name | Purpose |
|---------|----------|---------|
| **common** | `@agentic-obs/common` | Shared types, error classes, constants, model/config types, queue + event abstractions. Depends on no other `@agentic-obs/*` package. |
| **server-utils** | `@agentic-obs/server-utils` | Node-only server primitives: pino logging + request correlation, crypto (`secret-box`), Redis event bus, process lifecycle. Split out of `common` so browser-facing code never pulls in Node built-ins. |
| **adapters** | `@agentic-obs/adapters` | Data adapters for observability backends: Prometheus (metrics), Loki and Humio (logs), change events, web search, and execution adapters (kubectl, cluster shell, generic shell). Also owns the canonical `AdapterError` taxonomy. |
| **llm-gateway** | `@agentic-obs/llm-gateway` | Provider-agnostic completion API. Implemented providers: Anthropic, OpenAI, OpenAI-compatible (Azure OpenAI, DeepSeek, corporate gateways), Gemini, Ollama. Also token accounting, pricing, and `apiKeyHelper` resolution. |
| **data-layer** | `@agentic-obs/data-layer` | Persistence: repository interfaces with SQLite (better-sqlite3 + Drizzle), Postgres, and in-memory implementations; schema application; Redis cache. |
| **agent-core** | `@agentic-obs/agent-core` | Agent logic: the orchestrator, the ReAct loop, the tool schema registry, per-tool handlers, permission gate, and audit reporting. |
| **api-gateway** | `@agentic-obs/api-gateway` | Express HTTP server: REST routes, auth (local / OAuth / SAML / LDAP), RBAC, SSE + socket.io streaming, background workers, and service orchestration. The main entry point (`dist/main.js`). |
| **web** | `@agentic-obs/web` | React SPA: dashboard workspace, investigation views, chat, setup wizard, settings, admin pages. Vite + Tailwind CSS. |
| **cli** | `@syntropize/rounds` | The published npm package. `bin/rounds.mjs` sets `DATA_DIR` defaults and boots the bundled server built by `scripts/build-cli.mjs`. No `src/` — it has no logic of its own. |

## Dependency Rules

Actual `@agentic-obs/*` edges, as declared in each `package.json` and mirrored
by the TypeScript project references in each `tsconfig.json`:

1. **common** depends on no other workspace package. Every package may depend on it.
2. **server-utils** depends on common.
3. **adapters** depends on common and server-utils.
4. **llm-gateway** depends on adapters (for `AdapterError` / `classifyHttpError`), common, and server-utils.
5. **data-layer** depends on common and server-utils.
6. **agent-core** depends on adapters, common, llm-gateway, and server-utils. It also imports a few repository *types* from data-layer, which is therefore a `devDependency` plus a build reference — no value imports, so the runtime edge does not exist.
7. **api-gateway** depends on adapters, agent-core, common, data-layer, llm-gateway, and server-utils.
8. **web** depends on common only (shared types; no server packages).
9. **cli** declares no workspace dependencies — the build bundles workspace source into `dist/server.mjs`.

**Do not** introduce dependencies from lower layers to higher ones (e.g., common must never import from agent-core).

## Key Patterns

### Repositories (data-layer)

- **Repository** (`data-layer/src/repository/`) — the data access abstraction. One interface per entity (`interfaces.ts`, `gateway-interfaces.ts`) with `sqlite/`, `postgres/`, and `memory/` implementations selected by `repository/factory.ts` at boot. Handles SQL, serialization, and caching.
- `data-layer/src/stores/` is a remnant of the store→repository migration (ADR-001, Sprint 4). Only the in-memory notification store and the dirty-tracking persistence primitives still live there. New entities get a repository, not a store.

### Agent Architecture (agent-core)

There is a single agent class, `OrchestratorAgent` (`agent/orchestrator-agent.ts`).
It does not delegate to sub-agent classes. Behaviour is composed from:

- **Agent definitions** (`agent/agent-registry.ts`) — three registered `AgentType`s, each a
  configuration (allowed tool names, permission mode, iteration ceiling), not a class:
  `orchestrator` (interactive chat), `background_orchestrator` (alert-triggered runs; adds the
  `remediation_plan_*` tools), and `verification`. The orchestrator picks one at construction
  time via `OrchestratorDeps.agentType`.
- **ReAct loop** (`agent/react-loop.ts`) — reason → act → observe, bounded by an iteration
  ceiling and a token budget, with observation truncation and context compaction.
- **Tool handlers** (`agent/handlers/`) — one module per domain (dashboard, investigation,
  alert, metrics, logs, ops, connectors, kb, github, remediation-plan, …). Tool schemas live in
  `agent/tool-schema-registry.ts`; `tool_search` fetches deferred schemas on demand.
- **Permission gate + audit** (`agent/permission-gate.ts`, `agent/tool-permissions.ts`,
  `agent/orchestrator-audit-reporter.ts`) — every dispatch is checked against the caller's
  identity and written to the audit log.
- **Factory** (`agent/factory.ts`) — `createAgentRunner()` is the only supported construction
  path; api-gateway never instantiates `OrchestratorAgent` directly.

Dashboard verification is a handler-level gate (`agent/handlers/verify-gate.ts`, toggled by
`DASHBOARD_VERIFY_GATE`), not a separate agent process.

### Error Handling

Structured error classes live in `common/src/errors/`:

```typescript
throw new NotFoundError('Investigation');    // 404
throw new ValidationError('email required'); // 400
throw new ConflictError('already exists');   // 409
```

The api-gateway error handler middleware maps `AppError` subclasses to HTTP responses automatically.

## Running

```bash
npm install          # install all dependencies
npm run build        # TypeScript build (all packages) + web bundle
npm test             # vitest (all packages)
npm run start        # start api-gateway + web dev server
```
