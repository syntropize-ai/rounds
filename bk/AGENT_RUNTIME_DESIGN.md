# Agent Runtime Design Draft

## Goal

Define an agent runtime for this repository that is:

- AI-native
- product-oriented
- observable
- safe to evolve
- compatible with the current package layout

This draft is based on the current repository structure:

- [`packages/common`](d:/shiqi/prism/packages/common)
- [`packages/agent-core`](d:/shiqi/prism/packages/agent-core)
- [`packages/api-gateway`](d:/shiqi/prism/packages/api-gateway)

and informed by lessons from [`claude-code-source-code`](d:/shiqi/prism/claude-code-source-code).

## Current Reality

The repository already has agents, but not yet a full agent runtime.

Today you already have:

- domain-level orchestration in [`packages/agent-core/src/orchestrator/orchestrator.ts`](d:/shiqi/prism/packages/agent-core/src/orchestrator/orchestrator.ts)
- product-facing orchestration in [`packages/api-gateway/src/routes/dashboard/agents/orchestrator-agent.ts`](d:/shiqi/prism/packages/api-gateway/src/routes/dashboard/agents/orchestrator-agent.ts)
- specialized agents such as:
  - [`dashboard-generator-agent.ts`](d:/shiqi/prism/packages/api-gateway/src/routes/dashboard/agents/dashboard-generator-agent.ts)
  - [`investigation-agent.ts`](d:/shiqi/prism/packages/api-gateway/src/routes/dashboard/agents/investigation-agent.ts)
  - [`alert-rule-agent.ts`](d:/shiqi/prism/packages/api-gateway/src/routes/dashboard/agents/alert-rule-agent.ts)
  - [`research-agent.ts`](d:/shiqi/prism/packages/api-gateway/src/routes/dashboard/agents/research-agent.ts)

What is still missing is a single runtime model that answers:

- what an agent is
- what tools it can use
- what asset types it can create or mutate
- what memory it can see
- what permissions it has
- how it runs in foreground vs background
- how it reports progress

## Core Design Principle

Do not treat agents as ad hoc helper classes.

Treat agents as first-class runtime units with:

- identity
- type
- capability boundary
- execution policy
- memory scope
- artifact permissions
- lifecycle state

That is the biggest lesson worth borrowing from Claude Code.

## Recommended Runtime Layers

### 1. `common`

Keep `common` focused on stable contracts only.

Own:

- shared domain types
- runtime enums and interfaces
- event types
- task status types
- artifact references

Suggested additions:

- `AgentType`
- `AgentRunMode`
- `AgentPermissionMode`
- `ArtifactKind`
- `AgentTaskStatus`
- `AgentProgressEvent`
- `AgentContextScope`

### 2. `agent-core`

`agent-core` should own domain reasoning and reusable agent logic.

Own:

- intent reasoning
- investigation reasoning
- evidence gathering logic
- alert reasoning
- explanation synthesis
- execution policy evaluation

Should not own:

- HTTP
- SSE
- route wiring
- frontend response shaping
- product page navigation

### 3. Application Layer

Add a dedicated application layer.

Suggested location:

- `packages/application`

or, if you want a smaller first step:

- `packages/api-gateway/src/application`

This layer should own:

- create dashboard from prompt
- update dashboard from chat
- generate investigation report from dashboard context
- generate alert rule from prompt or dashboard state
- link artifacts together
- start long-running agent tasks
- publish progress events

### 4. `api-gateway`

`api-gateway` should become a transport layer.

Own:

- auth
- request validation
- SSE / websocket transport
- serialization
- route-to-application mapping

Not own:

- core orchestration decisions
- direct artifact mutation logic
- long chains of agent coordination

## Agent Definition Model

Introduce a unified agent definition contract.

Suggested shape:

```ts
type AgentDefinition = {
  type: AgentType
  description: string
  purpose: string
  allowedTools: AgentToolName[]
  disallowedTools?: AgentToolName[]
  inputKinds: ArtifactKind[]
  outputKinds: ArtifactKind[]
  permissionMode: AgentPermissionMode
  memoryScope: AgentContextScope[]
  canRunInBackground: boolean
  requiresApproval?: boolean
  maxIterations?: number
}
```

Suggested first agent types:

- `intent-router`
- `dashboard-builder`
- `dashboard-editor`
- `panel-query-writer`
- `investigation-runner`
- `report-writer`
- `alert-rule-builder`
- `verification`
- `execution`
- `proactive-monitor`

## Capability Model

This is the most important structural upgrade.

Your system should not only check user permissions.
It should also check agent permissions.

Example:

- `intent-router`
  - can classify intent
  - cannot mutate assets directly
- `dashboard-builder`
  - can create dashboards and panels
  - cannot create alert rules
- `investigation-runner`
  - can read evidence and incidents
  - can create investigation artifacts and reports
  - cannot execute remediations
- `alert-rule-builder`
  - can create draft alert rules
  - cannot auto-enable high-severity rules without approval
- `execution`
  - can propose remediations
  - only executes through approval flow

This is where your existing approval and execution modules become much more valuable.

## Memory Model

Borrow the spirit of Claude Code's layered memory model, but adapt it to observability.

Suggested memory scopes:

- `user`
  personal preferences and habits
- `workspace`
  team-level conventions and datasource defaults
- `artifact`
  dashboard/report/alert-specific context
- `investigation-session`
  active reasoning state, hypotheses, evidence trail
- `ephemeral-turn`
  temporary prompt-local working memory

Examples:

- user memory:
  preferred chart styles, favored services, common phrasing
- workspace memory:
  canonical Prometheus datasource, service naming rules, folder conventions
- artifact memory:
  dashboard history, panel rationale, alert tuning notes
- investigation-session memory:
  active hypotheses, disproven causes, evidence references, confidence updates

## Artifact Model

Do not let dashboard remain the accidental universal container.

Treat these as sibling asset types:

- `dashboard`
- `investigation_report`
- `alert_rule`
- `incident`

Link them explicitly.

Suggested shared asset reference:

```ts
type ArtifactRef = {
  kind: ArtifactKind
  id: string
  title?: string
}
```

Suggested link model:

```ts
type ArtifactLink = {
  source: ArtifactRef
  target: ArtifactRef
  relation:
    | 'generated_from'
    | 'investigates'
    | 'alerts_on'
    | 'derived_from'
    | 'references'
}
```

This will make your Explorer / Library UI much cleaner later.

## Execution Model

Support two run modes:

- foreground
- background

Foreground:

- good for dashboard chat edits
- request/response or SSE-driven

Background:

- good for long investigations
- proactive monitoring
- alert correlation
- verification
- report generation

Suggested task states:

- `queued`
- `running`
- `waiting_for_tool`
- `waiting_for_approval`
- `completed`
- `failed`
- `cancelled`

Suggested task record:

```ts
type AgentTask = {
  id: string
  agentType: AgentType
  status: AgentTaskStatus
  inputArtifacts: ArtifactRef[]
  outputArtifacts: ArtifactRef[]
  startedAt?: string
  finishedAt?: string
  summary?: string
  error?: string
}
```

## Progress Streaming Model

You already have SSE and websocket foundations.

Standardize agent progress events so all clients can consume them consistently.

Suggested events:

- `agent.started`
- `agent.thinking`
- `agent.tool_called`
- `agent.artifact_created`
- `agent.artifact_updated`
- `agent.waiting_for_approval`
- `agent.completed`
- `agent.failed`

Suggested payload shape:

```ts
type AgentProgressEvent = {
  taskId: string
  agentType: AgentType
  eventType: string
  message?: string
  artifact?: ArtifactRef
  timestamp: string
}
```

This will let the frontend render one consistent right-side AI activity panel.

## Verification Agent

This is the highest-leverage new agent to add.

Claude Code is right to make verification a distinct role.

For your product, verification should check:

- is generated PromQL valid
- does the query return data
- does the panel render meaningful series
- does the dashboard time range still produce useful output
- is the alert threshold realistic against recent history
- does the report cite real evidence
- do conclusions match evidence confidence

Suggested first responsibilities:

- `verify_dashboard`
- `verify_alert_rule`
- `verify_investigation_report`

This should be a read-mostly agent with strong guardrails.

## Recommended Package Changes

### Minimal change path

Keep current packages and add:

- `packages/api-gateway/src/application/`
- `packages/common/src/runtime/`

Suggested modules:

- `application/create-dashboard.ts`
- `application/update-dashboard-from-chat.ts`
- `application/generate-investigation-report.ts`
- `application/create-alert-rule.ts`
- `application/run-agent-task.ts`

Suggested runtime contracts in `common`:

- `runtime/agent.ts`
- `runtime/tasks.ts`
- `runtime/events.ts`
- `runtime/artifacts.ts`

### Stronger long-term path

Add:

- `packages/application`
- `packages/agent-runtime`

Where:

- `application` owns product use cases
- `agent-runtime` owns execution, task state, progress streaming, capability evaluation

This is cleaner, but probably a second step, not the immediate one.

## Migration Plan

### Phase 1

Standardize definitions without moving too much code.

- define `AgentType`, `ArtifactKind`, `AgentTaskStatus`
- define `AgentDefinition`
- wrap current specialized agents behind a common interface
- add task/progress event types

### Phase 2

Extract application services from route handlers.

- move dashboard chat orchestration out of routes
- move artifact linking logic into application layer
- keep routes thin

### Phase 3

Introduce capability and approval policies.

- agent-level permission checks
- approval gates for execution or risky alert activation
- explicit mutation scopes per agent

### Phase 4

Add verification and background task execution.

- verification agent
- resumable background tasks
- task history for frontend activity streams

## What To Borrow Directly From Claude Code

These ideas are directly worth borrowing:

- agent definitions are structured objects, not loose classes
- different agents have different tools and different system roles
- read-only planning/exploration roles are useful
- verification should be a distinct role
- memory should be layered
- long-running agent tasks need lifecycle and progress state
- permission should be runtime-aware, not only user-aware

## What Not To Copy Directly

Do not copy Claude Code literally in these areas:

- terminal-centric tool assumptions
- file-oriented memory model
- coding-agent-specific task flows
- worktree/fork semantics as-is

Your product is asset-centric, not file-centric.
The equivalent of a worktree in your system is closer to:

- draft dashboard session
- draft investigation workspace
- draft alert rule state

## Bottom Line

Your project is ready to evolve from “agents inside routes” into a real agent runtime.

The next architectural jump is:

- define agents formally
- define artifact permissions formally
- define task lifecycle formally
- define memory scopes formally
- move orchestration into an application layer

If you do that well, the system can support:

- conversational dashboard creation
- iterative dashboard editing
- long-running investigations
- evidence-backed reports
- safe alert generation
- proactive AI monitoring

without collapsing into a route-centric monolith.
