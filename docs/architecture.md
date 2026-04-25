# Architecture

OpenObs is a TypeScript monorepo with distinct package boundaries between UI, API, agents, data access, and adapters.

## Package layout

```text
common
llm-gateway
data-layer
adapters
adapter-sdk
guardrails
agent-core
api-gateway
web
```

## Layer model

- `common` is the shared foundation
- `llm-gateway`, `data-layer`, and `adapters` sit above `common`
- `guardrails` and `agent-core` compose those lower layers
- `api-gateway` orchestrates everything server-side
- `web` consumes the API and shared types only

For the package-by-package explanation, see `ARCHITECTURE.md` in the repository root.
