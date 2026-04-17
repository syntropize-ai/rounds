# Implementation Rules (required reading for every agent)

**Status:** normative. If you're an agent implementing any task in this design, you MUST follow these rules.

## The one rule that matters most

**Do not simplify.** If the design doc says 5 tables, you build 5. If it says 23 actions in the catalog, you add 23. If a flow has 4 steps in Grafana, your flow has 4 steps.

Simplification is the default failure mode for engineering work delegated to agents. It feels like progress but it's drift. The whole point of this design is parity — the moment you cut a corner, the product stops being Grafana-compatible.

## The rule that matters second-most: license hygiene

**Grafana is AGPL-3.0. Do not copy source code from it.** AGPL is infectious — a verbatim block would force openobs under AGPL, which is unacceptable. This means:

- Read Grafana source to *understand* schema, flow, semantics. Then **close the file** and write your own implementation from understanding, in idiomatic openobs-style TypeScript.
- No line-by-line Go→TypeScript translation.
- No copied comments longer than a few standard words.
- No copied DDL — rewrite using our conventions (`TEXT` uuid PKs, `TEXT` ISO timestamps, our naming).
- No copied test case names / data.
- No copied error message strings beyond short standard phrases.

**What IS fine to share with Grafana** (interface facts, de-facto standards, operator-facing vocabulary — not copyrightable expression):
- Table names (`user`, `org`, `team`, `api_key`, ...).
- Self-descriptive column names (`name`, `email`, `created`, `role`, `scope`, `action`).
- Endpoint paths (`/api/orgs`, `/api/teams/search`) — API contracts are widely compatible.
- Action strings (`dashboards:read`, `folders:write`) — operator-facing vocabulary.
- Role names: `Admin`, `Editor`, `Viewer`, `None`.
- Permission bit values (1 / 2 / 4 for View / Edit / Admin).
- HTTP status codes and response shape (`{ message: "..." }`).

**Attribution comments**: a short reference like `// Schema follows grafana's org_user conventions (role enum + indexes).` is fine. Do NOT include verbatim excerpts as "documentation."

**Test scenarios**: use the scenarios listed in the design docs as the source of truth. Do not copy from Grafana `*_test.go` files.

If you've already written anything that's a verbatim port, rewrite it before proceeding. Every final report MUST include a "License hygiene" subsection confirming: you only read Grafana for understanding, you did not copy blocks, and nothing in your diff would look like a literal translation to a lawyer.

## Before you write a line of code

1. Read [00-overview.md](00-overview.md) to understand where your task fits.
2. Read the detailed design doc for your task (e.g. if you're T3.1, read [03-rbac-model.md](03-rbac-model.md) end-to-end).
3. Read [01-database-schema.md](01-database-schema.md) — even if your task isn't schema work, almost everything touches a table.
4. Open the Grafana source paths listed in your task's "Grafana references" section. Skim them. Keep them in tabs.
5. Read the existing openobs code you're about to replace. Understand what's there, what it does, and what's broken about it.

Only after all five should you start writing.

## During implementation

### Reference Grafana continuously

Every time you make a decision — field name, type, default value, order of operations, error message, HTTP status code — check how Grafana does it. If your choice differs, either:

- Match Grafana exactly (default), **or**
- Add a comment `// [openobs-deviation] <reason>` explaining why we diverge.

Unexplained divergence will fail review.

**How to consult Grafana source:**
- Each task lists specific file paths under "Grafana references".
- Use `WebFetch` for the raw file: `https://raw.githubusercontent.com/grafana/grafana/v11.3.0/pkg/services/user/user.go`.
- Never paraphrase from memory. Memory drifts. Fetch the actual file.

### Schema rules

- Exact column names as written in [01-database-schema.md](01-database-schema.md). Don't camelCase a column documented as snake_case.
- Every foreign key declared in the design doc is a real FK in the migration. No "we'll enforce in application code."
- Indexes listed in the design doc MUST be created in the migration.
- Soft-delete columns (`deleted_at`) are not used unless the design doc says so. Grafana hard-deletes most rows; we match that.

### API rules

- Endpoint paths, methods, and response shapes MUST match [08-api-surface.md](08-api-surface.md) exactly.
- If Grafana returns `{ message: "..." }` on error, so do we.
- HTTP status codes match Grafana's choices (e.g., 403 vs 401 distinction for auth failures).
- No endpoint-level simplifications. If Grafana has 6 admin user endpoints, we have 6.

### Test rules

Every task MUST include:

1. **Unit tests** for every new service / repository / middleware function. Coverage target: 80%+ line coverage on new code.
2. **Integration tests** that hit the HTTP layer and verify DB side effects. At minimum one "happy path" and two "permission denied" cases per endpoint.
3. **Fixture-based tests** when comparing to Grafana behavior. E.g., for the permission evaluator, test the exact scenarios from `pkg/services/accesscontrol/acimpl/service_test.go`.

If a task lists specific test scenarios in its design doc, all of them must be implemented.

### Comment + commit rules

- Comments explain *why*, not *what*. If you're citing a Grafana file, inline the citation:
  ```ts
  // Mirror grafana's rotation cadence — see
  // pkg/services/auth/authimpl/user_auth_token.go:215 (RotateToken).
  ```
- Commit messages in this feature set prefix with the task ID, e.g., `T2.2: persist user_auth_token to SQLite`.
- Every PR references the design doc section it implements.

### Do not touch out-of-scope code

Each task has an explicit file scope in its design doc. Touching files outside that scope is not allowed even if you see something that looks wrong. File an issue / note in your report instead.

## When you're stuck

1. Re-read the design doc for your task, focusing on the Grafana references.
2. Fetch the exact Grafana file and re-read that function.
3. If the Grafana code itself is ambiguous (it's a big codebase), prefer the behavior documented in `pkg/api/*.go` (HTTP handlers are the external contract) over internal service code.
4. If still unclear, write what you've concluded in your final report with the question marked, and let the reviewer resolve.

## Don't do these things

- **No feature flags.** We're not gating parity behind a flag. It either works or the task isn't done.
- **No backward-compat shims with the current broken implementation.** Wave 6 (T9) handles cutover atomically.
- **No "TODO: handle X"** in merged code. Either handle it or explicitly document in the design that it's out of scope.
- **No renaming things to be "more readable".** If Grafana calls it `IsGrafanaAdmin`, we call it `IsServerAdmin` (one deliberate rename — see [04-organizations.md](04-organizations.md) §naming). Beyond that one, match Grafana's names.
- **No adding columns "for future use".** YAGNI.
- **No reaching outside your file scope to "clean up while I'm here".** File an issue.

## Cross-checking before you report complete

Before declaring a task done, verify:

- [ ] Every table / field / endpoint / action listed in the design doc for this task is implemented.
- [ ] Tests exist and pass locally (`npm test` within the affected workspace).
- [ ] Typecheck is clean: `npx tsc --build`.
- [ ] For each Grafana reference file listed in your task, spot-check at least one function against your implementation — match or deviation-commented.
- [ ] The design doc itself isn't out of date. If you learned something during implementation, update the design doc in the same commit.
- [ ] Your report includes a "Grafana reference check" section listing the files you consulted and any `[openobs-deviation]` markers you added.

## Report format (when you complete a task)

```
### Task: <task id> — <task title>

**Implemented:**
- <schema / endpoint / class / ...> — <one-line summary>
- ...

**Tests:**
- <N> unit tests added in <file>
- <M> integration tests added in <file>
- All passing: <yes/no>

**Grafana reference check:**
- `pkg/services/user/user.go` — read for semantics; our impl re-written from scratch
- `pkg/services/user/model.go` — read; we diverge on PK type (TEXT uuid) by design
- ...

**License hygiene:**
- Grafana source was read only to understand schema and behavior. No code, comments, or DDL blocks were copied.
- Attribution references in comments are short factual pointers (e.g. "matches grafana's rotation cadence"), not excerpts.
- I inspected my final diff for AGPL leakage; nothing would look like a literal translation to a lawyer.

**Deviations from design doc:**
- <none>, OR
- <list with justification>

**Out-of-scope observations (not fixed in this task):**
- <bug / concern / TODO filed to docs/auth-perm-design/NN-YYY.md>
```

## The spirit, in short

You are not writing "basically like Grafana". You are writing *the same thing as Grafana*, adapted to openobs's TypeScript/Node/SQLite stack, with the same semantics, the same guarantees, and the same mental model. A Grafana operator should feel at home.

If you find yourself wanting to skip something "for now" — stop and re-read this file.
