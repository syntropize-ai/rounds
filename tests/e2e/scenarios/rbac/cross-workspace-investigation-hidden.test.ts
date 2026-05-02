/**
 * Investigations are workspace-scoped: a record in workspace A must be
 * invisible from a request authenticated for workspace B (Ref PR #124,
 * `findByIdInWorkspace` filter).
 *
 * Skipped: the e2e harness seeds a single org/workspace by design.
 * Driving this scenario requires creating a second org + a user with
 * membership in only the second org; the bootstrap seed doesn't expose
 * a knob for that. Coverage exists at the repository layer (
 * `findByIdInWorkspace` test in data-layer).
 */
import { describe, it } from 'vitest';

describe.skip('rbac/cross-workspace-investigation-hidden (Ref PR #124)', () => {
  it('investigation in workspace A is 404 from workspace B', () => {
    // Recipe:
    //   1. POST /api/orgs (admin) to create workspace B
    //   2. createUser('Editor') and assign to org B only
    //   3. Create an investigation in org A (default seed)
    //   4. GET /api/investigations/:id as B's user — expect 404 not 200/403.
  });
});
