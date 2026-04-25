# Contributing

Thanks for your interest. Contributions of any size are welcome — typo fixes, bug reports, new datasource integrations, anything in between.

## How to contribute

The `main` branch is protected — direct pushes are blocked, all changes flow through pull requests.

1. **Fork** the repo: <https://github.com/openobs/openobs/fork>
2. **Clone** your fork and create a topic branch:
   ```bash
   git clone https://github.com/<you>/openobs.git
   cd openobs
   git checkout -b my-fix
   ```
3. **Make your change** (see [Development Setup](#development-setup) below). Add a test if you're changing behavior.
4. **Run checks locally** — CI runs the same things, faster to catch issues here:
   ```bash
   npm run typecheck
   npm run lint
   npm test
   npm run build
   ```
5. **Commit, push, open a PR** against `openobs/openobs:main`. Fill out the PR template.
6. **Wait for review.** A maintainer will leave comments or approve. PRs need ≥1 approval and green CI before merge.

If you're tackling something non-trivial, open an issue first to align on the approach — saves rework if the design needs adjusting.

## Reporting bugs

Open an issue at <https://github.com/openobs/openobs/issues> with: what you expected, what happened, steps to reproduce, and your `openobs --version` / Node version / OS.

## Reporting security issues

**Do not** open a public issue. Email security details privately to the maintainers.

## Project Structure

```
packages/
  common/          # shared types, errors, utilities
  llm-gateway/     # LLM provider abstraction
  data-layer/      # SQLite persistence (Drizzle ORM)
  adapters/        # observability backend adapters
  adapter-sdk/     # SDK for building custom adapters
  guardrails/      # safety guards (cost, rate, policy)
  agent-core/      # AI agent logic
  api-gateway/     # Express HTTP server (entry point)
  web/             # React SPA (Vite + Tailwind)
config/            # default configuration (YAML)
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the dependency graph and design decisions.

## Development Setup

```bash
git clone <repo-url> && cd openobs
npm install
cp .env.example .env     # configure JWT_SECRET (min 32 chars) and LLM keys
npm run build             # required before first run
npm run start             # starts api-gateway on :3000 + web on :5173
```

## Where Business Logic Goes

| What you're building | Where it goes |
|---------------------|---------------|
| New AI agent or phase | `packages/agent-core/src/` |
| New REST endpoint | `packages/api-gateway/src/routes/` |
| New database table | `packages/data-layer/src/db/migrate.ts` (schema) + `sqlite-schema.ts` (Drizzle) |
| New store interface | `packages/data-layer/src/stores/` |
| New UI page | `packages/web/src/pages/` |
| New UI component | `packages/web/src/components/` |
| New LLM provider | `packages/llm-gateway/src/providers/` |
| Shared type or constant | `packages/common/src/` |

## How to Add a New Adapter

1. Create a new directory under `packages/adapters/src/` (e.g., `packages/adapters/src/my-backend/`)
2. Implement the relevant interface from `packages/adapters/src/adapter.ts` (`DataAdapter`, `IMetricsAdapter`, etc.)
3. Export from `packages/adapters/src/index.ts`
4. Register in `packages/adapters/src/registry.ts` if using the adapter registry

For **execution adapters** (actions like restart, scale, create ticket):

1. Use `packages/adapter-sdk/` — extend `BaseAdapter`
2. Define capabilities and action schemas
3. See `packages/adapters/src/execution/` for examples

## Testing

```bash
npm test                    # run all tests (vitest)
npm test -- --watch         # watch mode
npx vitest run <file>       # run a specific test file
```

Tests live next to their source files (e.g., `foo.test.ts` alongside `foo.ts`) or in `__tests__/` directories.

## Documentation

Product documentation lives in this repository under `docs/`, not in the marketing website repository.

- Use `npm run docs:dev` for local docs authoring
- Use `npm run docs:build` before publishing docs changes
- Keep docs updates in the same PR as the related product change when possible

### What to Test

- **Agent logic**: mock the LLM gateway, assert on tool calls and outputs
- **Store/Repository**: use in-memory implementations or SQLite with `:memory:`
- **Routes**: test via supertest or mock request/response objects
- **React components**: use vitest + testing-library if applicable

## Code Style

- TypeScript strict mode, ES modules (`.js` extensions in imports)
- Use `camelCase` for variables and functions, `PascalCase` for types and classes
- Prefer `type` imports (`import type { ... }`) when only using types
- No `as any` — use proper typing or `unknown` with narrowing
- Error handling: use structured error classes from `@agentic-obs/common` (see `AppError`, `NotFoundError`, `ValidationError`, etc.)

## Commit Messages

- Use imperative mood: "Add feature" not "Added feature"
- Keep the first line under 72 characters
- Reference issues when applicable

## Pull Requests

- One logical change per PR
- Include a brief description of what and why
- Ensure `npm run build` and `npm test` pass before submitting
