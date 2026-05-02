/**
 * Scope boundary: a user with `folders:write` on `folders:uid:A` should
 * be denied a write to a folder in B.
 *
 * Skipped: the seeded basic roles grant `folders:*` (unrestricted) to
 * Editor. Asserting a scope-bounded grant requires constructing a custom
 * role with `scope: 'folders:uid:<A>'` and assigning it to a Viewer —
 * that flow needs custom-role create + folder-scoped permission write
 * and is gated separately. Once a helper exists, this scenario should
 * exercise:
 *   1. createFolder(A); createFolder(B)
 *   2. mint custom role: { permissions: [{ action: 'folders:write',
 *      scope: 'folders:uid:<A>' }] }
 *   3. assignRole(viewerId, customRoleUid)
 *   4. PUT /api/folders/<A> as viewer → not 403
 *   5. PUT /api/folders/<B> as viewer → 403
 */
import { describe, it } from 'vitest';

describe.skip('rbac/scope/folder-write-boundary', () => {
  it('folder-scoped grant blocks writes outside the granted folder', () => {
    // see file header for recipe
  });
});
