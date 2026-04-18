/**
 * Unit tests for OrgSwitcher visibility logic.
 *
 * The React component itself requires a DOM for interactive tests; here we
 * cover the invariant that matters most for acceptance: the switcher is
 * hidden when the user belongs to 0 or 1 orgs.
 */

import { describe, it, expect } from 'vitest';
import { shouldRenderOrgSwitcher } from './OrgSwitcher.js';

describe('shouldRenderOrgSwitcher', () => {
  it('is hidden when orgs is undefined', () => {
    expect(shouldRenderOrgSwitcher(undefined)).toBe(false);
  });

  it('is hidden when the user has no orgs', () => {
    expect(shouldRenderOrgSwitcher([])).toBe(false);
  });

  it('is hidden when the user has exactly one org', () => {
    expect(shouldRenderOrgSwitcher([{ orgId: 'org_main' }])).toBe(false);
  });

  it('is shown when the user has two or more orgs', () => {
    expect(
      shouldRenderOrgSwitcher([{ orgId: 'org_a' }, { orgId: 'org_b' }]),
    ).toBe(true);
  });

  it('is shown when the user has many orgs', () => {
    const orgs = Array.from({ length: 5 }, (_, i) => ({ orgId: `org_${i}` }));
    expect(shouldRenderOrgSwitcher(orgs)).toBe(true);
  });
});
