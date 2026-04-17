/**
 * Grafana ref: pkg/services/apikey/model.go::APIKey
 * See docs/auth-perm-design/01-database-schema.md §api_key
 * See docs/auth-perm-design/06-service-accounts.md for owner_user_id.
 *
 *  - serviceAccountId null  => personal access token.
 *  - serviceAccountId set   => service-account token.
 *  - `key` stores SHA-256 hex (never plaintext).
 */
export interface ApiKey {
  id: string;
  orgId: string;
  name: string;
  /** SHA-256 hex of the token. */
  key: string;
  /** Legacy Grafana API-key role ('Admin' | 'Editor' | 'Viewer'); real perms via RBAC. */
  role: string;
  created: string;
  updated: string;
  lastUsedAt: string | null;
  /** ISO-8601 expiry; null = never. */
  expires: string | null;
  /** FK to user.id where isServiceAccount=true. null = personal access token. */
  serviceAccountId: string | null;
  /** openobs-only: user who minted the token. */
  ownerUserId: string | null;
  isRevoked: boolean;
}

export interface NewApiKey {
  id?: string;
  orgId: string;
  name: string;
  key: string;
  role: string;
  expires?: string | null;
  serviceAccountId?: string | null;
  ownerUserId?: string | null;
}

export interface ApiKeyPatch {
  name?: string;
  role?: string;
  lastUsedAt?: string | null;
  expires?: string | null;
  isRevoked?: boolean;
}
