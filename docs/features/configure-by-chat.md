# Configure by chat

Connectors and a small set of org settings can be changed by asking, instead of
by filling in the Settings page.

```
connect my prod Prometheus at http://prometheus.monitoring:9090
```

The agent works out which template fits, checks the address answers, shows you
what it is about to create, and waits. Nothing is written until you say yes.

## What actually happens

**1. Propose.** The agent picks a connector template, builds the config, and
probes the URL. You get back the name, the type, the address, the capabilities
it would gain, and whether a credential is still needed. No row exists yet.

**2. Apply.** On your confirmation, the connector is created under your own
RBAC — the agent cannot write anything you could not write yourself — and
attributed to you in the audit log the same way a Settings-page change is.

**3. Test.** Applying probes the connector and reports what came back. A failed
probe does not undo the save: a wrong address is information, not a reason to
throw away the rest of the configuration. You are told which it was.

Two steps rather than one because a connector points at a system and carries a
credential. Getting an address subtly wrong is easy, and finding out on your
next question — with the agent reporting "no data" — reads as the product being
broken rather than the address being wrong.

## Drafts expire

A proposal lives for **30 minutes**, in memory, scoped to your organisation,
and is single-use. Restarting the server drops it. If you come back to a stale
proposal you get:

```
No draft <id> — it expired or was already applied. Propose the connector again.
```

Ask again; nothing was left half-created.

## Settings the agent may change

Deliberately short. Only these three:

| Setting | What it controls |
|---|---|
| `investigation.default_time_range` | how far back an investigation looks by default |
| `dashboard.default_refresh_interval` | how often dashboards re-query |
| `alerts.default_evaluation_interval` | how often alert rules are evaluated |

Anything else is refused, and the refusal names the three:

```
"auth.session_timeout" cannot be changed from chat. Agent-writable settings:
investigation.default_time_range, dashboard.default_refresh_interval,
alerts.default_evaluation_interval.
```

The list is short on purpose. These three change how the product behaves for
you; they cannot weaken authentication, widen permissions, or alter who may
approve a remediation. Those stay on the Settings page and the API, where a
human is unambiguously the actor. Widening this list is a security decision,
not a convenience one.

## What it does not do

- **It cannot grant itself access.** Every write goes through the same RBAC
  check as the equivalent REST call. An account without `connectors:create`
  gets the same refusal in chat that it gets in the UI.
- **It cannot supply credentials you have not given it.** A template needing an
  API key proposes with `needsCredential` set and waits for you.
- **It does not touch existing connectors implicitly.** Changing one is its own
  request, with its own confirmation.

## See also

- [Datasources](/features/datasources) — the connector types and what each supports
- [Risk model](/reference/risk-model) — how agent-initiated writes are classified
- [Security](/auth) — the RBAC these tools run under
