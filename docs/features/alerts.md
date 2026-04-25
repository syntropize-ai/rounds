# Alert rules

Define, manage, and tune alert rules through chat — or click through the UI. OpenObs handles the lifecycle: rule creation, evaluation, notification, history, and silencing.

## What you can do

- **Create from a prompt** — "Alert me when the API error rate exceeds 1% for 5 minutes"
- **Modify existing rules** — "Change the threshold on the high-latency alert to 500ms"
- **Delete safely** — confirmation prompt before destructive changes; audit-logged
- **List & filter** — `alert_rule.list` returns rules by folder, severity, state
- **Inspect history** — `alert_rule.history` shows every state transition (firing / pending / resolved) with the values that triggered them

## How to use it

### Create a rule

In chat:

> Alert when the 5xx rate on the checkout service is above 1% for 5 minutes

The alert agent runs:

1. `metrics.metric_names` / `metrics.labels` to find the right metric + labels
2. `metrics.validate` to confirm the rule expression is well-formed
3. `create_alert_rule` with: name, expression, threshold, evaluation interval, for-duration, severity, notification channels

### Modify a rule

> Bump the threshold on `high-checkout-latency` to 800ms

Agent calls `alert_rule.list` to find the rule by name, then `modify_alert_rule` with the new threshold. The change is immediate; next evaluation cycle uses the new value.

### Inspect what fired

> Show me the firing history for `high-error-rate` over the last 24h

`alert_rule.history` returns the state transitions; the chat renders them as a timeline with the trigger values.

### Silence a rule temporarily

Use the UI: Alerts → Silences → New. (Silences aren't currently exposed as agent tools to keep them deliberate / auditable.)

## Examples

| Prompt | Resulting rule |
|---|---|
| `Alert me when disk usage on any host exceeds 90%` | `node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.10`, for 10m, severity=warning |
| `Page on-call when the order pipeline error rate > 5%` | Custom expression scoped to the order datasource, severity=critical, routes to PagerDuty |
| `Warn if Redis memory > 80% for 15 min` | `redis_memory_used_bytes / redis_memory_max_bytes > 0.80`, for 15m |

## Limits

- Alert rules need a metric expression. Log-based alerts (Loki ruler) are planned but not in the current release.
- Notification channels (Slack, PagerDuty, email, webhook) configured separately under Admin → Notifications.
- Folder-scoped permissions apply: `alert.rules:write` on `folders:uid:<id>` controls who can create/modify rules in that folder.
- The agent doesn't auto-silence on dependent failures; chain alerts via the notification dispatcher's `groupBy` + `inhibit` rules instead.

## Related

- [Investigations](/features/investigations) — investigate why an alert fired
- [Datasources](/features/datasources) — alert rules query the same datasources as dashboards
- [Permissions](/auth#built-in-roles-permission-summary) — `basic:editor` includes alert.rules write; narrow with custom roles
