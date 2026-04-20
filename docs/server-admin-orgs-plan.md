# Server-admin org-edit page — plan (2026-04-19)

Goal: Grafana-parity Server Admin UX for cross-org user management. Caught in
W5 smoke: the Orgs tab currently only supports Rename / Delete, with no way to
manage members of a non-current org. To manage members of `robinhood` today,
the Server Admin has to switch their active org via OrgSwitcher — that's the
regular Org Admin flow, not the Server Admin one.

## Grafana reference (semantic — no source copied)

Two separate admin surfaces:

| Page | Gate | API | What it does |
|---|---|---|---|
| `/admin/orgs` | `isGrafanaAdmin` | `GET /api/orgs` | Lists every org with user count. Row-click → edit page. |
| `/admin/orgs/:id` | `isGrafanaAdmin` | `GET/POST/PATCH/DELETE /api/orgs/:id/users` | Rename org, list/add/update/remove members cross-org (no OrgSwitcher needed). |
| `/org/users` (current) | `org_user.role=Admin` | `/api/org/users` | Manages the active org only. |

openobs has the third page only. Below fills in the first two.

## Task breakdown — one commit, `Admin: server-admin org-edit page`

### T1. Backend: user count on list

- `GET /api/orgs` response adds `userCount: number` per row.
- Implementation: extend `orgs.list()` service method (or a new
  `listWithMemberCounts()`) to `LEFT JOIN org_user GROUP BY o.id` and return
  `{ ...Org, userCount }`.
- File to touch: `packages/api-gateway/src/services/org-service.ts`,
  `packages/data-layer/src/repository/auth/org-repository.ts` (or wherever
  `list()` lives), `packages/api-gateway/src/routes/orgs.ts` (pass through
  the new field).
- Existing pagination envelope (`{ totalCount, items, page, perPage }`) stays.
- No schema change.

### T2. Frontend: Orgs row → drill-down

- `packages/web/src/pages/admin/Orgs.tsx`:
  - Remove the `?? '—'` fallback on the Users column (all server-admin rows
    now carry a real count post-T1).
  - Add a "Manage members" `RowAction` that navigates to `/admin/orgs/:id`.
  - Make the Name cell itself a link to the same route (matches Grafana's
    whole-row-clickable behavior).
- Row is only interactive if the viewer is a Server Admin; for non-admins this
  tab is already hidden by the existing route gate (confirm).

### T3. New page `/admin/orgs/:id`

- New file: `packages/web/src/pages/admin/OrgUsers.tsx`.
- Layout mirrors `Users.tsx` (table + search + role-select + remove action +
  "+ New user" modal) but scope is a specific org via `/api/orgs/:id/users`.
- Header shows the org name (fetch `GET /api/orgs/:id` once on mount) with a
  back link to `/admin/orgs`.
- Inline rename affordance at the top (`PATCH /api/orgs/:id`). Reuses the
  existing `RenameOrgModal` — just lift it into shared `admin/_shared` if it
  isn't already exported.
- Uses `api.get<PagedResponse<OrgUserDTO>>('/orgs/${id}/users?...')` which is
  the envelope fixed in commit `28ffcb4`. Guarantee: items has `login`,
  `email`, `name`, `role`.
- Wire the route in `packages/web/src/pages/Admin.tsx` (or wherever admin
  sub-routes are registered). Server-admin gate: redirect to `/admin` for
  non-admins, matching how the existing tabs handle it.

### T4. Rip off a small piece of refactor if it makes T3 cleaner

- The table body / role-select / remove flow in `Users.tsx` is ~100 LOC
  duplicated between "current org users" and "this org users" if T3 copies.
  If a sensible `UsersTable` extraction fits, do it — but only if it fits
  in the same commit without bloating the diff. Otherwise copy once; the
  second page is the natural trigger to refactor later.

### T5. Tests

- Backend: extend existing orgs integration test (`routes/__integration__/orgs.test.ts`)
  to assert `res.body.items[0].userCount` matches the number of `org_user` rows.
- Frontend: existing E2E smoke isn't wired; skip unless easy. Typecheck
  (`npx tsc --build`) must pass.

## Principles

- Root-cause fix: the envelope is already right (W3 / commit 28ffcb4); just
  populate the missing `userCount` field and add the drill-down path.
- No new backend route — `/api/orgs/:id/users` already exists and was fixed
  to the pagination envelope in the same W3 commit.
- One commit, subject `Admin: server-admin org-edit page (Grafana parity)`.
- Do NOT push.

## Non-goals (explicit)

- No bulk import of users.
- No per-org theming / branding.
- No cross-org role definitions (each org has its own copy from
  `seedRbacForOrg`).
