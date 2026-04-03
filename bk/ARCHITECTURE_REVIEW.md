# Architecture Review

## Overall Assessment

The repository already looks like an AI-native observability platform rather than a simple dashboard generator. The current package split is directionally strong:

- `packages/common`: domain model + platform primitives
- `packages/adapters`: datasource and execution adapters
- `packages/agent-core`: agent logic and orchestration
- `packages/api-gateway`: API surface and product-facing workflows

The system already supports the product direction of:

- generating dashboards from natural language
- generating investigation reports
- generating alert rules
- running proactive monitoring and correlation flows

That is a strong foundation.

## What Is Working Well

### 1. Domain model is coherent

The shared model layer is strong and aligned with the product vision:

- `packages/common/src/models/dashboard.ts`
- `packages/common/src/models/investigation.ts`
- `packages/common/src/models/alert.ts`
- `packages/common/src/models/incident.ts`
- `packages/common/src/models/evidence.ts`
- `packages/common/src/models/action.ts`

This is not random schema accumulation. It already expresses a real observability product with AI-generated artifacts.

### 2. Product intent and backend structure match

The codebase does reflect the intended user experience:

- dashboard creation/editing through chat
- investigation report generation
- alert rule generation
- proactive anomaly/change/SLO pipelines

Important files:

- `packages/api-gateway/src/routes/dashboard/router.ts`
- `packages/api-gateway/src/routes/dashboard/chat-handler.ts`
- `packages/api-gateway/src/routes/dashboard/agents/orchestrator-agent.ts`
- `packages/api-gateway/src/proactive-pipeline.ts`

### 3. Foundational platform primitives already exist

The repository already has many of the hard platform pieces that most early products skip:

- event bus
- queue abstraction
- telemetry
- structured logging
- graceful shutdown
- config loader

Important files:

- `packages/common/src/events/index.ts`
- `packages/common/src/queue/index.ts`
- `packages/common/src/logging/index.ts`
- `packages/common/src/lifecycle/shutdown.ts`
- `packages/common/src/config/loader.ts`

### 4. There is already a usable orchestration concept

There are two important orchestration ideas present:

- platform-level investigation orchestration in `packages/agent-core/src/orchestrator/orchestrator.ts`
- product-facing ReAct orchestration in `packages/api-gateway/src/routes/dashboard/agents/orchestrator-agent.ts`

This means the codebase already moved beyond static generation and toward agentic workflows.

## Key Problems

### 1. Too much product logic lives inside `api-gateway`

This is the biggest structural issue right now.

Files like these are carrying too much responsibility:

- `packages/api-gateway/src/routes/dashboard/chat-handler.ts`
- `packages/api-gateway/src/routes/dashboard/router.ts`
- `packages/api-gateway/src/routes/dashboard/agents/orchestrator-agent.ts`

They currently combine several concerns:

- HTTP/API routing
- SSE streaming
- chat session handling
- product workflow orchestration
- LLM tool routing
- store updates
- side effects on dashboards/reports/alerts

This is manageable early on, but it will become the main source of complexity later.

Why this matters:

- harder to test use cases independently from Express
- harder to reuse orchestration outside HTTP
- harder to evolve product flows without touching route code
- harder to add another client surface later

### 2. Asset types are partially forced into the dashboard surface

There is a product-model boundary issue around dashboards vs investigation reports.

In the current implementation, investigation artifacts are still managed through the dashboard route surface:

- `packages/api-gateway/src/routes/dashboard/router.ts`
- `packages/api-gateway/src/routes/dashboard/investigation-report-store.ts`

This works now, but it suggests that investigation reports are being treated as dashboard-adjacent resources instead of first-class assets.

Risk:

- awkward API semantics
- type branching everywhere
- dashboard route layer becoming the catch-all product route

Suggestion:

- make `dashboard`, `investigation_report`, and `alert_rule` feel like sibling asset types
- keep linking between them, but avoid forcing all artifacts through dashboard-shaped APIs

### 3. The architecture has orchestration in two places without a clean boundary

There is a lower-level orchestrator in `agent-core`:

- `packages/agent-core/src/orchestrator/orchestrator.ts`

And a product-facing orchestrator in `api-gateway`:

- `packages/api-gateway/src/routes/dashboard/agents/orchestrator-agent.ts`

This is not necessarily wrong, but the boundary is currently blurry.

Questions the architecture should answer more clearly:

- What belongs to domain-agent orchestration?
- What belongs to product workflow orchestration?
- Which layer owns user intent routing?
- Which layer owns output artifact creation?

Without a cleaner split, both orchestrators may grow into partially duplicated control planes.

### 4. Missing application service layer

The repository has:

- domain model
- adapters
- agents
- API routes

But it does not yet have a clearly named and separated application service layer.

That missing layer should own use cases such as:

- create dashboard from chat prompt
- modify dashboard through conversation
- generate investigation report from dashboard context
- generate alert rule from prompt and dashboard state
- persist and link assets together

Right now those use cases are spread across route files and agent wrappers.

### 5. Persistence model appears underdeveloped relative to product ambition

From the repository shape, stores exist, but the long-term asset lifecycle still looks thin:

- dashboard store
- conversation store
- incident store
- feed store
- report store

What is still likely missing or immature:

- version history
- draft vs published state
- provenance of AI edits
- rollback / revision compare
- durable links between dashboard/report/alert/incident
- audit trail for human vs AI changes

For this product, these are not optional details. They will become core product expectations.

### 6. Multi-tenant / org / folder / permissions model is still too light

There are signs of auth and permissions in `api-gateway`, but the asset model still appears early-stage for a serious observability product.

Potential future gap areas:

- organizations / workspaces
- folder hierarchy semantics
- resource ownership
- sharing rules
- alert visibility boundaries
- dashboard/report/incident access scopes

This matters because your target product is not just single-user AI tooling. It is a collaborative operational surface.

### 7. Dist artifacts are checked in heavily across packages

This is not a conceptual architecture flaw, but it increases repository noise and maintenance cost.

The repository currently carries both:

- `src`
- `dist`

for several packages.

Risks:

- source-of-truth confusion
- PR noise
- accidental edits to generated outputs
- slower review cycles

If checked-in `dist` is required, the build discipline needs to stay very explicit.

### 8. Some product semantics still feel implementation-driven

Several route and module names still reflect implementation convenience more than product boundaries.

Examples:

- dashboard routes owning investigation concerns
- route-local stores representing durable product entities
- alert generation attached through dashboard conversation logic

This is normal at this stage, but it is a signal that product capabilities are growing faster than architecture boundaries.

## Biggest Risks If Left As-Is

### 1. `api-gateway` becomes the monolith

The most likely failure mode is not poor agent logic. It is `api-gateway` becoming the central place for:

- business rules
- orchestration
- persistence coordination
- transport adaptation
- session logic
- presentation flow logic

That would slow down product iteration later.

### 2. Dashboard becomes the accidental universal container

If every AI output is routed through dashboard workflows, the model will become harder to evolve when:

- reports need independent lifecycle
- alerts need their own creation and governance flow
- incidents need stronger linkage and state management

### 3. Orchestration logic will fragment

If user-intent routing, domain-agent sequencing, and product-side asset mutation are not explicitly separated, future changes will create duplicated orchestration logic across:

- `agent-core`
- `api-gateway`
- dashboard-specific agent wrappers

## Recommended Next Steps

### 1. Introduce an application layer

Add a dedicated package or module group for use cases, for example:

- `packages/application`
- or `packages/api-gateway/src/application`

This layer should own:

- create dashboard
- chat update dashboard
- generate investigation report
- generate alert rule
- link artifacts together

Routes should become thin transport adapters into application services.

### 2. Separate artifact types more clearly

Treat these as first-class assets:

- dashboards
- investigation reports
- alert rules
- incidents

They can remain linked, but should not all be modeled through dashboard-centric workflows.

### 3. Define orchestration boundaries explicitly

Recommended split:

- `agent-core`: domain reasoning and agent pipelines
- application layer: product workflow orchestration and asset creation
- `api-gateway`: transport, auth, streaming, validation

### 4. Add lifecycle/versioning strategy for AI-generated assets

At minimum define:

- draft vs published
- revision history
- human-edited vs AI-edited provenance
- rollback behavior
- linked artifact metadata

This is especially important for:

- dashboards
- alert rules
- investigation reports

### 5. Elevate organization/folder/access model

The product likely needs explicit definitions for:

- workspace / tenant
- folder ownership
- user/org roles
- visibility rules
- alert/report/dashboard sharing boundaries

### 6. Keep `common` stable and avoid letting it become a dumping ground

`packages/common` is currently strong.

Protect that by keeping it focused on:

- shared domain model
- runtime primitives
- low-level platform contracts

Avoid moving product workflow logic into it.

## Bottom Line

This repository is already strong enough to justify real product confidence.

The main issue is not lack of ideas or lack of backend structure.
The main issue is that the product workflow layer is starting to outgrow the current route-centric implementation shape.

In short:

- the domain foundation is good
- the agent direction is good
- the product intent is visible in the code
- the next challenge is architectural separation, not feature invention

If this is addressed well, the codebase can grow into the AI-first observability product you are aiming for without collapsing into gateway-centered complexity.
