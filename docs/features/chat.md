# Chat & agent

Chat is the fastest way to use Rounds. Ask in plain language, watch the agent work, then continue from the same session or open the resource it created.

## What to ask

- `Create a dashboard for HTTP latency`
- `Open the ingress gateway dashboard`
- `Alert me when checkout error rate is above 1%`
- `Investigate why p99 latency jumped this morning`
- `Show pending approvals`
- `Connect my dev Prometheus`

Rounds can create, find, explain, edit, and investigate resources. When a request is ambiguous, it asks a short follow-up instead of guessing.

## Activity trace

The activity trace shows the agent's work as compact steps. Expand a step when you need details such as queried metrics, selected connector, or validation result. The final answer stays separate from the trace so the conversation reads naturally.

## Sessions and Recents

Every chat is a session. Use **Recents** in the sidebar to reopen a conversation. When the agent opens a dashboard, alert, or investigation, the same session should continue with that resource instead of becoming a separate replay.

## Confirmation and approvals

Read-only work can run immediately. Mutating or risky work requires confirmation or approval:

- chat confirmations for user-led changes;
- Action Center approvals for background or higher-risk actions;
- RBAC gates that remove tools the user cannot run.

## Model settings

Admins configure the LLM provider in **Settings → AI** or during setup. Supported provider families include Anthropic, OpenAI-compatible APIs, Gemini, DeepSeek, Azure OpenAI, AWS Bedrock, local Ollama/Llama, and corporate gateways when configured.

## Tips

- Name the service, cluster, connector, or time window when you know it.
- Ask the agent to open existing resources before asking it to create new ones.
- Use follow-ups inside the same session: `compare with yesterday`, `split by route`, `make this less noisy`.
