// Share-link types — canonical home after store→repository migration (Sprint 4).

export type SharePermission = 'view_only' | 'can_comment';

export interface ShareLink {
  token: string;
  investigationId: string;
  createdBy: string;
  permission: SharePermission;
  createdAt: string;
  expiresAt: string | null;
}

export type ShareLookupResult =
  | { kind: 'ok'; link: ShareLink }
  | { kind: 'expired' }
  | { kind: 'not_found' };
