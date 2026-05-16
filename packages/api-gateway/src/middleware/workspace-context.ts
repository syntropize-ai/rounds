import type { Request } from 'express';

/**
 * Extract the org identifier from a request.
 *
 * Post-T9 cutover: the legacy "workspace" concept is gone. Routes should use
 * `req.auth.orgId` populated by auth/org context; the explicit header/query
 * branch is only for tests and bootstrap surfaces that intentionally pass an
 * org before the auth chain has run. Missing org context is a programming
 * error, not a signal to fall back to a synthetic default workspace.
 */
export function getOrgId(req: Request): string {
  const authed = (req as Request & { auth?: { orgId?: string } }).auth;
  if (authed?.orgId) return authed.orgId;
  const headerOrgId = req.headers['x-openobs-org-id'];
  if (typeof headerOrgId === 'string' && headerOrgId) return headerOrgId;
  const queryOrgId = req.query['orgId'];
  if (typeof queryOrgId === 'string' && queryOrgId) return queryOrgId;
  throw new Error('org context missing');
}
