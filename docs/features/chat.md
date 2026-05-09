# Chat & agents

The chat panel is how you operate OpenObs as an **AI SRE**. Behind it is a multi-agent system: the **orchestrator** picks the right tool for each turn, the **alert-rule agent** handles alert lifecycle, and the **investigation agent** runs structured incident workflows across telemetry and (when configured) cluster state.

The agent talks SRE: incidents, metrics, logs, traces, dashboards, alerts, runbooks, remediations. Internally those map to "connectors" and "tools" — but you don't need that vocabulary to use the product. Connector terminology only shows up where it actually matters: settings, capabilities, and the auto-remediation reference docs.

## What you can do

- **Ask anything** — "what dashboards do I have", "create one for HTTP latency", "investigate the 5xx spike at 9am"
- **Operate dashboards by conversation** — create, explain, clone, modify, rearrange, or delete dashboards without hand-editing JSON
- **Investigate production symptoms** — ask why latency, errors, saturation, or alerts changed; the agent can query metrics, logs, changes, and Kubernetes when configured
- **Approve risky actions in-chat** — read-only tools run inline; mutating actions surface as **Run / Confirm / Apply** with a risk note, evidence, and a one-line summary of what will change. No formal `ApprovalRequest` is created unless a permission gate or the GuardedAction risk model demands one. (Background-agent runs use a separate Approve / Reject / Modify path — see [Auto-remediation](/operations/auto-remediation).)
- **Stream the agent's thinking** — every step (tool call, result, decision) renders live in the panel as it happens
- **Multi-tool turns** — the agent can run several tools in parallel in one turn (e.g. 4 quantile queries at once) for speed
- **Continue across sessions** — chats persist; reopen a thread to continue
- **Override the model** — switch between Claude / GPT / Gemini / Ollama on a per-session basis
- **Adjust effort** — `OPENOBS_THINKING_EFFORT=low|medium|high` tunes how much extended thinking the model does before acting

## How it works

OpenObs implements a **ReAct loop** (Reason + Act). On each turn:

1. Model receives conversation history + tool definitions
2. Model emits one or more `tool_use` calls (native function-calling, no prose JSON parsing)
3. OpenObs executes each tool, returns the result as `tool_result`
4. Loop repeats until the model emits `reply` / `finish` / `ask_user`

Because tool calls are native (not prompted JSON), the model picks tools more accurately and you can swap in any provider that supports function calling.

### Available tools

| Category | Tools | Used for |
|---|---|---|
| Discovery | `datasources.list`, `dashboard.list`, `alert_rule.list`, `investigation.list` | Find what exists |
| Metrics | `metrics.query`, `range_query`, `labels`, `label_values`, `series`, `metadata`, `metric_names`, `validate` | Discover + query metric backends |
| Logs | `logs.query`, `logs.labels`, `logs.label_values` | Search log backends |
| Kubernetes | `ops.run_command` | Inspect cluster state and prepare approval-gated remediation |
| Changes | `changes.list_recent` | Correlate with deployments / config changes |
| Web | `web.search` | External research (best practices, error codes) |
| Dashboards | `dashboard.create`, `add_panels`, `modify_panel`, `remove_panels`, `add_variable`, `set_title`, `rearrange` | Build / edit dashboards |
| Alerts | `create_alert_rule`, `modify_alert_rule`, `delete_alert_rule`, `alert_rule.history` | Manage alert lifecycle |
| Investigations | `investigation.create`, `add_section`, `complete` | Structured incident analysis |
| Navigation | `navigate` | Open a URL in the user's browser |
| Conversation | `reply`, `finish`, `ask_user` | Terminal actions |

## How to use it

### Start a chat

Click the chat button (bottom right). Type a prompt. Watch the step trace as the agent works.

### Continue a chat

Sidebar → Chats → click any past conversation. The agent loads the full history; you can pick up where you left off.

### Switch models

Settings → Models → pick provider + model. Effective immediately for new chats. Existing chats keep their original model unless you explicitly retry.

### Tune the effort

For complex tasks, more deliberation pays off:

```bash
export OPENOBS_THINKING_EFFORT=high   # low | medium (default) | high
```

`low` ≈ 1024 thinking tokens, `medium` ≈ 4096, `high` ≈ 16384. Only models that support extended thinking honor this — the rest silently ignore it. See [supported models](#supported-models).

### Cancel a long-running task

Click the stop button next to "Working..." in the chat panel. The agent receives a cancellation signal and emits a `reply` with what it managed to accomplish before stopping.

## Supported models

| Provider | Tool-use | Extended thinking |
|---|---|---|
| Anthropic | All Claude 3.x and 4.x | Claude 3.7+ and all 4.x |
| OpenAI | All GPT-4+ and o-series | o1, o3, o4, gpt-5.x (reasoning_effort) |
| Gemini | 1.5+ | 2.5+ (thinkingConfig) |
| Ollama | Tool-capable models only (llama3.1, qwen2.5, mistral, qwen3) | Model-dependent — best-effort, not surfaced |

Models without tool-use support are rejected at session start with an error pointing to a tool-capable model.

## Permissions

The chat respects RBAC. The agent only sees tools the current user has permission to invoke:

- `chat:use` — required to open a chat at all
- Per-tool permissions — e.g. `dashboards:write` is required for `dashboard.create`; without it, the tool is removed from the agent's available set
- Folder-scoped permissions cascade to the tools that touch that folder's resources

So a `Viewer` can ask the agent to read dashboards but can't ask it to create one — the agent itself doesn't know about the missing tool, it just won't be in the prompt.

## Limits

- Per-session token budget — large conversations get auto-compacted (older messages summarized) to stay under the model's context window. Crucial IDs (dashboardId, investigationId) are preserved in the summary.
- Multi-tool parallelism caps at the model's native limit (Anthropic: ~10, OpenAI: similar). The agent doesn't artificially cap.
- The agent is read-only by default for sub-tasks like investigations; mutations require the orchestrator path, RBAC, and approval where the target is an infrastructure change.

## Related

- [Dashboards](/features/dashboards) — main use case
- [Investigations](/features/investigations) — structured incident workflow
- [Alert rules](/features/alerts) — alert lifecycle via chat
- [Permissions](/auth#built-in-roles-permission-summary) — `chat:use`, `agent:use`, tool-level gates
