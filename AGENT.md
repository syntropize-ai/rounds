# AGENT.md

Orientation for coding agents working in this repository. For behavioral rules
(scope discipline, simplicity, no fallback code) see [CLAUDE.md](./CLAUDE.md) —
this file is about *this repo*, not about how to write code in general.

## What this is

Rounds is a self-hosted AI SRE. An LLM-driven agent investigates incidents,
builds dashboards, manages alert rules, and — behind approval gates — proposes
and executes remediations against Kubernetes. It reads from your existing
telemetry (Prometheus-compatible metrics, Loki/Humio logs, change events); it
never stores a second copy of that data.

TypeScript monorepo, npm workspaces, ES modules (`.js` extensions in relative
imports), TypeScript strict mode.

## Package map

| Package | What lives there |
|---|---|
| `packages/common` | Shared types, `AppError` hierarchy, model/config types, queue + event abstractions. Depends on no other workspace package. |
| `packages/server-utils` | Node-only primitives: pino logging + request correlation, crypto (`secret-box`), Redis event bus, lifecycle. |
| `packages/adapters` | Backend adapters — Prometheus, Loki, Humio, change events, web search, and execution adapters (kubectl, cluster shell, shell). Owns `AdapterError`. |
| `packages/llm-gateway` | Provider-agnostic completions: Anthropic, OpenAI + OpenAI-compatible, Gemini, Ollama. Pricing, token accounting, `apiKeyHelper`. |
| `packages/data-layer` | Repositories with `sqlite/`, `postgres/`, and `memory/` implementations; schema application; Redis cache. |
| `packages/agent-core` | The orchestrator, the ReAct loop, tool schemas, tool handlers, permission gate, audit. |
| `packages/api-gateway` | Express server: routes, auth (local/OAuth/SAML/LDAP), RBAC, SSE + socket.io, background workers. Entry point `dist/main.js`. |
| `packages/web` | React SPA (Vite + Tailwind). Imports only `@agentic-obs/common` from the workspace. |
| `packages/cli` | Packaging only. `bin/rounds.mjs` boots the bundle produced by `scripts/build-cli.mjs`. |

Dependency direction and the full layer diagram: [ARCHITECTURE.md](./ARCHITECTURE.md).

## The agent, concretely

There is one agent class — `OrchestratorAgent` in
`packages/agent-core/src/agent/orchestrator-agent.ts`. There are no sub-agent
classes. What varies is configuration:

- `agent/agent-registry.ts` registers three `AgentType`s — `orchestrator`
  (interactive), `background_orchestrator` (alert-triggered; adds
  `remediation_plan_*`), `verification` — each a set of allowed tool names, a
  permission mode, and an iteration ceiling.
- `agent/react-loop.ts` runs reason → act → observe under an iteration ceiling
  and a token budget.
- `agent/tool-schema-registry.ts` holds every tool schema; `tool_search` loads
  deferred schemas on demand.
- `agent/handlers/*.ts` implement the tools, one module per domain.
- `agent/permission-gate.ts` + `agent/tool-permissions.ts` check every dispatch
  against the caller's identity; denials are audited, not silently swallowed.
- Construct agents through `createAgentRunner()` (`agent/factory.ts`) — never
  `new OrchestratorAgent()` outside agent-core.

Adding a tool means touching: `agent-types.ts` (name), `tool-schema-registry.ts`
(schema), `handlers/` (implementation), `agent-registry.ts` (allowlist), and
`tool-permissions.ts` (required permission).

### Standing constraints

- **Writes are gated.** Mutating cluster actions are either confirmed inline by
  the user or delivered as a `RemediationPlan` with approve/reject controls.
  Nothing executes silently.
- **GitHub integration is read-only (Phase 1).** The `github_*` tools list
  repos/PRs and fetch diffs; there is no inbound API that opens a PR. When the
  agent would mutate a provisioned (file/git-backed) resource, the write gate
  throws and `agent/provisioned-diff.ts` renders a copy-pasteable markdown diff
  instead.
- **Connectors are read-only for telemetry.** Rounds never writes back to
  Prometheus or Loki; alert and recording rules live in its own database.

## Commands

```bash
npm run build       # tsc --build (all packages) + web bundle
npm run typecheck
npm run lint
npm test            # vitest; tests are packages/*/src/**/*.test.ts
npm run start       # api-gateway on :3000 + web dev server on :5173
npm run dist        # build the publishable @syntropize/rounds package
npm run docs:dev    # VitePress docs site in docs/
```

## Conventions that bite

- Relative imports carry the `.js` extension even in `.ts` files.
- No `as any`; use `unknown` plus narrowing.
- Throw the structured errors from `@agentic-obs/common` (`NotFoundError`,
  `ValidationError`, `ConflictError`, …) — the api-gateway error middleware maps
  them to status codes.
- Configuration is environment variables *only* where
  [docs/configuration.md](./docs/configuration.md) and `.env.example` say so.
  LLM provider settings and connectors live in the database, not in env.
- Docs are part of the change: `docs/` is published to GitHub Pages, so update
  it in the same PR as the behavior it describes.
