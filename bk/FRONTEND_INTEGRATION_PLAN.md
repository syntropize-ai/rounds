# Frontend Integration Plan

## Goal

Connect the Stitch UI concepts in [`stitch`](d:/shiqi/prism/stitch) to the existing backend in [`packages/api-gateway`](d:/shiqi/prism/packages/api-gateway).

The product shape is already clear:

- one AI-first entry point
- three primary outputs: dashboard, investigation report, alert
- one shared visual system
- one persistent AI editing loop

There is not yet a dedicated frontend package in this repo, so this document defines the first frontend routing and API contract to implement.

## Recommended App Routes

- `/`
  AI home / prompt entry
- `/dashboards`
  dashboard library
- `/dashboards/:dashboardId`
  dashboard canvas with right-side AI chat
- `/reports`
  investigation report library
- `/reports/:reportId`
  investigation report detail
- `/alerts`
  alert rule library
- `/alerts/new`
  AI-generated alert creation/editing
- `/explorer`
  unified asset library

## Stitch Screen Mapping

### 1. AI Home

Source:
- [`stitch/ai_curator_home_screen/code.html`](d:/shiqi/prism/stitch/ai_curator_home_screen/code.html)

Use for:
- landing page
- initial prompt entry
- intent routing

Backend:
- [`/api/intent`](d:/shiqi/prism/packages/api-gateway/src/routes/intent.ts)

Behavior:
- send user message as SSE request
- show streamed progress events like `thinking`, `intent`, `done`, `error`
- navigate on final event

Expected navigation:
- dashboard -> `/dashboards/:dashboardId`
- investigate -> `/dashboards/:dashboardId` initially, then fetch report if generated
- alert -> `/alerts`

Notes:
- this is the best first page to ship
- it already matches your “single conversation box” product thesis

### 2. Dashboard Canvas

Source:
- [`stitch/updated_ai_dashboard_view/code.html`](d:/shiqi/prism/stitch/updated_ai_dashboard_view/code.html)

Use for:
- main dashboard workspace
- time range control
- panel rendering
- right-side AI editing

Backend:
- [`GET /api/dashboards/:id`](d:/shiqi/prism/packages/api-gateway/src/routes/dashboard/router.ts)
- [`POST /api/dashboards`](d:/shiqi/prism/packages/api-gateway/src/routes/dashboard/router.ts)
- [`PUT /api/dashboards/:id`](d:/shiqi/prism/packages/api-gateway/src/routes/dashboard/router.ts)
- [`PUT /api/dashboards/:id/panels`](d:/shiqi/prism/packages/api-gateway/src/routes/dashboard/router.ts)
- [`POST /api/dashboards/:id/panels`](d:/shiqi/prism/packages/api-gateway/src/routes/dashboard/router.ts)
- [`DELETE /api/dashboards/:id/panels/:panelId`](d:/shiqi/prism/packages/api-gateway/src/routes/dashboard/router.ts)
- [`POST /api/dashboards/:id/chat`](d:/shiqi/prism/packages/api-gateway/src/routes/dashboard/router.ts)
- [`GET /api/dashboards/:id/chat`](d:/shiqi/prism/packages/api-gateway/src/routes/dashboard/router.ts)
- [`POST /api/dashboards/:id/variables/resolve`](d:/shiqi/prism/packages/api-gateway/src/routes/dashboard/router.ts)
- [`POST /api/query/range`](d:/shiqi/prism/packages/api-gateway/src/routes/dashboard/query.ts)
- [`POST /api/query/instant`](d:/shiqi/prism/packages/api-gateway/src/routes/dashboard/query.ts)
- [`POST /api/query/batch`](d:/shiqi/prism/packages/api-gateway/src/routes/dashboard/query.ts)

Behavior:
- left side renders dashboard panels from stored panel config
- top bar time range is frontend state, passed into query requests
- right side AI chat uses SSE and applies incremental dashboard changes
- panel drag/resize persists through `PUT /api/dashboards/:id/panels`

Notes:
- this is the core product screen
- first implementation can keep panel editing simple:
  - title
  - PromQL
  - size
  - position
  - legend visibility

### 3. Investigation Report Detail

Source:
- [`stitch/investigation_report_view/code.html`](d:/shiqi/prism/stitch/investigation_report_view/code.html)

Use for:
- investigation narrative
- findings
- timeline
- AI explanation context

Backend:
- [`GET /api/dashboards/investigations`](d:/shiqi/prism/packages/api-gateway/src/routes/dashboard/router.ts)
- [`GET /api/dashboards/investigations/:reportId`](d:/shiqi/prism/packages/api-gateway/src/routes/dashboard/router.ts)
- [`GET /api/dashboards/:id/investigation-report`](d:/shiqi/prism/packages/api-gateway/src/routes/dashboard/router.ts)
- [`GET /api/investigations/:id`](d:/shiqi/prism/packages/api-gateway/src/routes/investigation/router.ts)
- [`GET /api/investigations/:id/stream`](d:/shiqi/prism/packages/api-gateway/src/routes/investigation/router.ts)

Behavior:
- if report is attached to a dashboard, fetch by dashboard id
- if report is a standalone asset view, fetch by report id
- optionally subscribe to investigation SSE for live progress

Notes:
- current backend stores report-like data in dashboard-related routes
- frontend should normalize this into a cleaner `/reports/:id` route

### 4. Alert Creation

Source:
- [`stitch/ai_alert_creation_view/code.html`](d:/shiqi/prism/stitch/ai_alert_creation_view/code.html)

Use for:
- AI-generated alert rule editing
- severity selection
- threshold preview
- notification policy assignment

Backend:
- [`POST /api/alert-rules/generate`](d:/shiqi/prism/packages/api-gateway/src/routes/alert-rules.ts)
- [`POST /api/alert-rules`](d:/shiqi/prism/packages/api-gateway/src/routes/alert-rules.ts)
- [`PUT /api/alert-rules/:id`](d:/shiqi/prism/packages/api-gateway/src/routes/alert-rules.ts)
- [`POST /api/alert-rules/:id/test`](d:/shiqi/prism/packages/api-gateway/src/routes/alert-rules.ts)
- [`POST /api/alert-rules/:id/investigate`](d:/shiqi/prism/packages/api-gateway/src/routes/alert-rules.ts)
- [`GET /api/notifications/contact-points`](d:/shiqi/prism/packages/api-gateway/src/routes/notifications.ts)
- [`GET /api/notifications/policies`](d:/shiqi/prism/packages/api-gateway/src/routes/notifications.ts)

Behavior:
- initial natural-language prompt can create draft alert rule
- page then edits structured fields
- investigate action can deep-link into a generated investigation workspace

Notes:
- this page is already well aligned with backend capabilities
- easiest second or third page to connect after dashboard

### 5. Explorer Library

Sources:
- [`stitch/explorer_library_view/code.html`](d:/shiqi/prism/stitch/explorer_library_view/code.html)
- [`stitch/advanced_explorer_folder_view/code.html`](d:/shiqi/prism/stitch/advanced_explorer_folder_view/code.html)

Use for:
- asset browsing
- dashboard/report/alert switching
- folder navigation
- search/filtering

Backend:
- [`GET /api/dashboards`](d:/shiqi/prism/packages/api-gateway/src/routes/dashboard/router.ts)
- [`GET /api/dashboards?type=investigation`](d:/shiqi/prism/packages/api-gateway/src/routes/dashboard/router.ts)
- [`GET /api/dashboards/investigations`](d:/shiqi/prism/packages/api-gateway/src/routes/dashboard/router.ts)
- [`GET /api/alert-rules`](d:/shiqi/prism/packages/api-gateway/src/routes/alert-rules.ts)

Behavior:
- assemble unified library client-side for v1
- group dashboards by `folder`
- merge reports and alerts into one explorer list model

Notes:
- backend does not yet expose a unified `assets` endpoint
- frontend should introduce a small adapter layer:
  - `listExplorerAssets()`
  - `listFolders()`
  - `openAsset()`

## Recommended Frontend Data Adapters

Create one thin client layer so the UI does not depend directly on raw route shape.

Suggested modules:

- `intentClient`
- `dashboardClient`
- `queryClient`
- `reportClient`
- `alertClient`
- `explorerClient`

Suggested normalized frontend types:

- `CanvasAsset`
- `DashboardViewModel`
- `ReportViewModel`
- `AlertRuleViewModel`
- `ExplorerFolder`
- `ChatStreamEvent`

## First Shipping Order

### Phase 1

- AI home
- dashboard canvas
- dashboard chat
- panel query execution

This is the shortest path to a convincing demo.

### Phase 2

- explorer library
- folder navigation
- report detail

This turns the product from “single generated dashboard” into a reusable workspace.

### Phase 3

- alert creation
- notification configuration
- alert-to-investigation jump

This completes the dashboard / report / alert triangle.

## Known Gaps To Handle In Frontend

- there is no dedicated frontend package yet
- reports are not modeled as a first-class top-level asset route in the backend
- explorer/folder data is not yet exposed as a unified asset API
- dashboard time-range state is mostly frontend-owned right now
- panel interactions like legend toggling and drag layout will need frontend implementation details even though persistence already exists

## Recommendation

If you want to move fast, build the first frontend package around only these two stitched flows:

- home -> intent stream -> navigate
- dashboard -> query panels -> right-side AI chat edits dashboard

That path is already strongly supported by the backend and best represents the product.
