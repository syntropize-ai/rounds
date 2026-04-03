import type { Request } from 'express';

/** Extract workspaceId from request -- checks header, query param, or JWT payload */
export function getWorkspaceId(req: Request): string {
  // Priority: header > query > JWT claim > default
  return (req.headers['x-workspace-id'] as string)
    ?? (req.query['workspaceId'] as string)
    ?? (req as any).user?.workspaceId
    ?? 'default';
}
