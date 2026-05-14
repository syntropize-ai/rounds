# AI-Native Resource Organization

## Problem

Rounds currently exposes Grafana-style folders directly on the Dashboards page.
That is useful for compatibility and permissions, but it creates the wrong
product mental model:

- A folder may contain dashboards, alert rules, silences, and other resources,
  but the Dashboards page renders it like a dashboard-only directory.
- Alert-only folders look empty: "0 dashboards" even when they contain alert
  rules.
- Users coming from Grafana expect a personal folder for scratch dashboards,
  but AI-generated work should not force users to manually organize every
  temporary exploration.
- AI workflows create related resources together: dashboard, alert rules,
  investigation notes, service context, and approvals. A plain file browser
  hides those relationships.

The product should keep Grafana-compatible folders as a storage and permission
primitive, while making the primary experience centered on work, ownership,
services, and AI-created resource relationships.

## Grafana Baseline

Grafana folders are not dashboard-only. They are an organization and permission
boundary for multiple resource types. Folder permissions apply to resources in
the folder, including dashboards and alert rules.

Compatibility requirements to preserve where they matter:

- Users browse folders and dashboards from the Dashboards section.
- Dashboards without a folder appear at the top level.
- Folders can be used to manage permissions for teams and roles.
- Alert rules can be scoped by folder for access control.
- Users often create personal folders named after themselves for scratch work.
- Power users rely on search, recent dashboards, starring, sharing links,
  copying dashboards, importing/exporting JSON, and moving dashboards between
  folders.

Rounds should preserve the useful compatibility layer without copying the
entire folder-first UX.

References:

- Grafana folder access control: https://grafana.com/docs/grafana/latest/administration/roles-and-permissions/folder-access-control/
- Grafana dashboard management: https://grafana.com/docs/grafana/latest/visualizations/dashboards/manage-dashboards/

## Product Principles

1. Folders are an RBAC and compatibility primitive, not the main user mental
   model.
2. Users should find work by service, owner, environment, recency, and health.
3. AI-created resources should be grouped automatically.
4. Personal scratch work should be first-class and private by default.
5. Team/shared resources should be promoted intentionally.
6. Grafana-style browsing remains available for migration, admin, and power use.

## Status & Scope

This document captures the long-term direction. Only RFC-1 (Folder UX honesty)
is committed for the current cycle. RFC-2 through RFC-6 are kept as future
direction but are out of scope until validated.

## RFC-1: Folder UX honesty (committed)

Goal: make the existing Dashboards page honest about what folders contain.
This is the only change needed to fix the reported user-visible bug
(alert-only folders rendering "0 dashboards").

### Folder Row

Current:

```text
Alerts
0 dashboards
```

Better:

```text
Alerts
0 dashboards · 3 alert rules
```

If the folder is alert-only and the current tab is Dashboards:

```text
Alerts
No dashboards · contains 3 alert rules
```

### Folder Detail Empty State

If a folder has no dashboards but has alert rules:

```text
This folder has no dashboards.
It contains 3 alert rules.

[View alert rules] [Create dashboard here]
```

### Folder Header

When inside a folder:

```text
Dashboards / Platform / Ingress Gateway
2 dashboards · 5 alert rules · 1 subfolder
```

### Search Results

Search should group mixed resource types:

```text
Folders
  Platform / Ingress Gateway

Dashboards
  HTTP Latency Monitoring

Alert rules
  P99 latency above threshold

Panels
  Request duration p99
```

### API: Folder Counts

Add counts to folder responses or a batch endpoint:

```http
GET /api/folders?includeCounts=true
```

Response:

```json
{
  "uid": "alerts",
  "title": "Alerts",
  "counts": {
    "dashboards": 0,
    "alertRules": 3,
    "subfolders": 0
  }
}
```

Batch alternative:

```http
POST /api/folders/counts
{ "uids": ["alerts", "platform"] }
```

### Tasks

- Add folder counts for dashboards, alert rules, and subfolders.
- Render mixed-resource counts in folder rows.
- Add alert-only folder empty state with "View alert rules".
- Keep Dashboards page focused on dashboards, but stop implying folders are
  dashboard-only.

## Deferred RFCs

The following RFCs sketch a longer-term direction. They are kept here so the
design conversation is not lost, but none are committed. Each has a gate that
must be cleared before promotion to a committed RFC.

### RFC-2: My Workspace (deferred)

Deferred until: RFC-1 ships and we have data on personal vs shared resource
usage.

A personal scratchpad that replaces the Grafana habit of manually creating a
folder named after yourself.

Default behavior:

- Every user gets a private workspace automatically.
- AI defaults temporary, ambiguous, or exploratory resources into My workspace.
- Items can be promoted to a team/service/shared location.
- Temporary items have lifecycle metadata.

Example:

```text
My workspace
  Drafts
    p99 latency debug        last opened 2h ago
    checkout error spike     last opened 2h ago
  Pinned
    my on-call view
  Archived
    old redis migration checks
```

Save flow destinations:

```text
Save to
  My workspace
  Service: ingress-gateway
  Team: Platform
  Shared library
```

Lifecycle fields:

- Draft / Pinned / Shared / Promoted / Archived
- `last_opened_at`
- manual `archived` state

Rounds will not auto-archive or auto-expire user resources. Lifecycle fields
are display-only and user-driven.

Saved explorations (lightweight query workspaces) are listed here as a candidate
resource type but are under-specified — see Open Risks. RFC-2 must either
define their CRUD/permission/storage model or scope them to ephemeral query
windows.

Promotion changes visibility and folder/RBAC placement. Promoting asks for
target service/team/folder, owner, description, whether to create matching
alert rules, and whether to notify a team.

Shared dashboards are never the default place for experiments. Users duplicate
to My workspace, iterate, and promote back.

### RFC-3: Library (deferred)

Deferred until: RFC-1 + RFC-2 ship.

Library is the mixed-resource browser and admin surface — the Grafana-compatible
power-user view.

Capabilities:

- Browse folders with mixed resource counts.
- Move resources between folders.
- Bulk archive/delete/move.
- Manage folder permissions.
- Import/export dashboard JSON and alert definitions.
- View provisioned vs user-created resources.
- See orphaned resources and resources without owner/service metadata.

Provisioning rules:

- Provisioned resources are read-only by default.
- Users can fork provisioned resources to My workspace.
- AI proposes PR-ready changes rather than mutating provisioned resources.
- Library shows source metadata: repo, path, commit, provisioner.

Permission changes show impact:

```text
This affects:
  8 dashboards
  12 alert rules
  3 silences
```

### RFC-4: Services (deferred)

Deferred until: a service-identity spike confirms ≥70% of resources can be
auto-attributed to a service from k8s labels / CODEOWNERS / manual tags.

Make service-centric organization the default operational model.

Each service page aggregates:

- Golden signal dashboard
- Related dashboards
- Alert rules
- Firing or noisy alerts
- Recent investigations
- Recent deploys / changes
- Owners and teams
- Environments and namespaces

Example:

```text
Ingress Gateway
  Health: warning
  Dashboards: 2
  Alert rules: 5
  Investigations: 3 recent
  Owner: Platform
  Environments: prod, staging
```

AI infers variables (service, namespace, workload, cluster, environment,
region, metric labels) so a dashboard opened from `ingress-gateway / prod`
scopes itself to that service and environment. Inferred variables must be
shown in the dashboard header on first open and confirmed by the user — see
Open Risks.

### RFC-5: Sharing, Versions, and Operational Views (deferred)

Deferred until: RFC-2 ships.

Sharing should be explicit, temporary when appropriate, and safe for personal
work.

Share options:

- Share with user / team
- Create expiring link
- Create incident snapshot (dashboard link, time range, variables, related
  alerts, AI summary)
- Promote to shared library

Dashboards have a version timeline with author, time, AI-generated change
summary, panel/query/variable/layout diff, restore, and duplicate-version-to-
My-workspace. Shared dashboards support a review flow before applying AI-
generated large changes.

Playlists / Views model rotating dashboards for wallboards and on-call rooms.
AI can generate a view from a service, team, or active incident.

### RFC-6: AI Resource Stewardship (deferred)

Deferred. Likely folds into a single Home "AI suggestions" inbox rather than 6
surfaces.

Gap detection surfaces through a single Home "AI suggestions" inbox with
snooze/dismiss, not as 6 independent channels.

## Information Architecture (deferred direction)

The long-term navigation shape that RFC-2 through RFC-6 build toward:

```text
Home
Services
Dashboards
Alerts
Investigations
My workspace
Library
Settings
```

Home is the operational command center: what is unhealthy, what changed, what
needs approval, recent AI-created resources, open investigations, pinned
services, personal drafts. Home answers "what should I do now?", not "where
did I file something?"

## Data Model

Existing folder fields stay:

```text
dashboard.folder_uid
alert_rule.folder_uid
folder.uid
```

For deferred RFCs, formalize:

```text
resource_visibility
  personal | team | shared | provisioned

resource_owner
  user_id
  team_id
  service_id

resource_lifecycle
  draft | active | temporary | archived
  last_opened_at
```

Relations are encoded as explicit foreign keys on the resource
(e.g. `dashboard.service_id`, `alert_rule.dashboard_panel_ref`) and via the
existing provenance table for chat-session → resource creation lineage. A
generic `resource_relation` table is rejected as over-abstraction.

## Open Risks (from review)

- **Service identity is not solved.** RFC-4's Service view assumes resources
  can be auto-attributed to a service. Until a spike validates this, the
  Service view will mis-attribute or under-attribute resources and will be
  worse than the folder view.
- **My workspace vs folder duality.** RFC-2 must decide whether My workspace
  is a real folder (`uid: user:<id>`) or a virtual collection. Implementing
  both creates two stores of truth. Pick one in the RFC-2 design doc.
- **Promote flow crosses RBAC boundaries.** Promoting personal drafts into
  shared collections must integrate with the GuardedAction confirmation model
  and audit log — not a silent metadata edit.
- **Variable inference is high-stakes.** Wrong namespace = wrong data.
  RFC-4 must show inferred variables in the dashboard header on first open
  and require user confirmation, not silent injection.
- **Saved Explorations are under-specified.** Treated as a third resource type
  here without CRUD / permission / storage design. RFC-2 must either define
  them properly or scope them down to ephemeral query windows.

## Open Questions

- Should My workspace be implemented as a real folder, a virtual collection,
  or both?
- Should personal dashboards be visible to org admins by default?
- What is the default retention for temporary resources?
- Do we want a separate Explore page, or should chat + scratch panels replace
  it?
- Should service ownership come from Kubernetes labels, manually assigned
  teams, GitHub CODEOWNERS, or all of the above?
- How should provisioned/GitOps resources behave when AI wants to modify them?

## Recommendation

Ship RFC-1 now. It is the only piece needed to fix the reported user-visible
bug (alert-only folders showing "0 dashboards") and it does not commit the
product to any larger IA change.

Treat RFC-2 through RFC-6 as direction, not commitment. Each requires its
own validation gate (see "Deferred until" lines) before promotion to a
committed RFC.

Folders stay as the RBAC and compatibility backbone in all scenarios.
