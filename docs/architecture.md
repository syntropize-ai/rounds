# Architecture

Rounds is a TypeScript monorepo with distinct package boundaries between UI, API, agents, data access, and adapters.

## Package layout

```text
common
server-utils
adapters
llm-gateway
data-layer
agent-core
api-gateway
web
cli
```

## Layer model

- `common` is the shared foundation and depends on no other package
- `server-utils` adds Node-only primitives (logging, crypto, event bus) on top of `common`
- `adapters`, `llm-gateway`, and `data-layer` sit above `common` + `server-utils`
  (`llm-gateway` also uses the `adapters` error taxonomy)
- `agent-core` composes `llm-gateway` and `adapters` into the orchestrator, its
  tool handlers, and the ReAct loop
- `api-gateway` orchestrates everything server-side
- `web` consumes the API and shared types only
- `cli` is packaging: it bundles the server and the built web assets into the
  published `@syntropize/rounds` npm package

For the package-by-package explanation, see `ARCHITECTURE.md` in the repository root.
