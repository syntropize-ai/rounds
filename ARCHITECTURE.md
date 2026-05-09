# Architecture

OpenObs is an open-source AI SRE: an LLM-driven agent that investigates incidents, builds dashboards, manages alert rules, and (with approval) remediates. Kubernetes is the first deep ops connector; Prometheus alerting rules, Loki routing, GitHub PR-based fixes, Jira / PagerDuty incident sync, CI/CD systems, and database read connectors are planned. It is structured as a TypeScript monorepo with 9 packages.

## Layer Diagram

```
                  +-----------+
                  |    web    |  React SPA (Vite)
                  +-----+-----+
                        |
                  +-----v-----+
                  | api-gateway|  Express HTTP server
                  +-----+-----+
                        |
          +-------------+-------------+
          |             |             |
    +-----v-----+ +----v----+ +------v------+
    | agent-core | |data-layer| | llm-gateway |
    +-----+------+ +----+----+ +-------------+
          |              |
    +-----v-----+  +-----v-----+
    | adapters   |  |  common   |
    +-----+------+  +-----------+
          |
    +-----v------+
    | adapter-sdk |  (for building custom adapters)
    +------------+
```

## Package Responsibilities

| Package | Purpose |
|---------|---------|
| **common** | Shared types, error classes, constants, and utilities used by every package. Zero dependencies on other `@agentic-obs/*` packages. |
| **llm-gateway** | Unified interface for calling LLMs (Anthropic, OpenAI, Gemini, Ollama, Azure, Bedrock). Provider-agnostic completion API. |
| **data-layer** | Persistence: SQLite schema, Drizzle ORM, repository implementations, and gateway store interfaces. |
| **adapters** | Data adapters for observability backends: Prometheus (metrics), log aggregation, distributed tracing, change events, web search, and execution adapters (k8s, CI/CD, tickets, notifications). |
| **adapter-sdk** | SDK for building custom execution adapters. Provides `BaseAdapter`, validation utilities, and a scaffold generator. |
| **guardrails** | Safety guards: cost tracking, query rate limiting, confidence thresholds, action policy enforcement, and credential resolution. |
| **agent-core** | AI agent logic: dashboard generation, investigation, alert rule creation, panel editing, verification, and the ReAct orchestration loop. |
| **api-gateway** | Express HTTP server: REST routes, auth middleware, SSE streaming, and service orchestration. The main entry point. |
| **web** | React SPA: dashboard workspace, investigation views, setup wizard, settings, and admin pages. Built with Vite + Tailwind CSS. |

## Dependency Rules

1. **common** is the foundation. Every package may depend on it. It depends on nothing.
2. **llm-gateway** depends only on common.
3. **data-layer** depends only on common.
4. **adapters** depends on common.
5. **adapter-sdk** depends on common (shared adapter types live in common).
6. **guardrails** depends on common, adapters, and llm-gateway.
7. **agent-core** depends on common, llm-gateway, data-layer, adapters, and guardrails.
8. **api-gateway** depends on everything except web and adapter-sdk.
9. **web** depends on common (types only, no server packages).

**Do not** introduce dependencies from lower layers to higher ones (e.g., common must never import from agent-core).

## Key Patterns

### Store vs Repository (data-layer)

- **Repository** (`data-layer/src/repository/`) — data access abstraction. One interface per entity, with SQLite implementations. Handles SQL, serialization, and caching.
- **Store** (`data-layer/src/stores/`) — business-layer convenience interfaces. Used by api-gateway routes and agent-core agents. Wraps repositories with pagination, filtering, and domain logic.

### Agent Architecture (agent-core)

Agents follow a delegation model:

- **OrchestratorAgent** classifies user intent and dispatches to sub-agents
- **DashboardGeneratorAgent** creates dashboards via research → plan → build phases
- **InvestigationAgent** runs plan → query → analyze → report pipeline
- **AlertRuleAgent** generates alert rules from natural language
- **VerifierAgent** validates generated artifacts before applying them

The orchestrator uses a **ReAct loop** (reason → act → observe) for multi-step conversations.

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
npm run build        # TypeScript build (all packages)
npm test             # vitest (all packages)
npm run start        # start api-gateway + web dev server
```
