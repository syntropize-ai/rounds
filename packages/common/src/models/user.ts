/**
 * Grafana ref: pkg/services/user/model.go::User
 * See docs/auth-perm-design/01-database-schema.md §user
 *
 * Service accounts are rows in the same table with isServiceAccount=true.
 */
export interface User {
  id: string;
  version: number;
  email: string;
  name: string;
  login: string;
  /** scrypt hash (salt embedded per openobs format); null for SA rows. */
  password: string | null;
  /** Present for Grafana parity but unused — see 01-database-schema.md §user. */
  salt: string | null;
  /** Grafana uses for session cookie; openobs retains column for parity only. */
  rands: string | null;
  company: string | null;
  /** User's default / current org. FKs to org(id). */
  orgId: string;
  /** Server admin flag — Grafana's `IsAdmin` / "Grafana Admin". */
  isAdmin: boolean;
  emailVerified: boolean;
  theme: string | null;
  helpFlags1: number;
  isDisabled: boolean;
  isServiceAccount: boolean;
  created: string;
  updated: string;
  lastSeenAt: string | null;
}

export interface NewUser {
  id?: string;
  email: string;
  name: string;
  login: string;
  password?: string | null;
  salt?: string | null;
  rands?: string | null;
  company?: string | null;
  orgId: string;
  isAdmin?: boolean;
  emailVerified?: boolean;
  theme?: string | null;
  helpFlags1?: number;
  isDisabled?: boolean;
  isServiceAccount?: boolean;
}

export interface UserPatch {
  email?: string;
  name?: string;
  login?: string;
  password?: string | null;
  salt?: string | null;
  rands?: string | null;
  company?: string | null;
  orgId?: string;
  isAdmin?: boolean;
  emailVerified?: boolean;
  theme?: string | null;
  helpFlags1?: number;
  isDisabled?: boolean;
  isServiceAccount?: boolean;
}

/**
 * Grafana ref: pkg/services/login/model.go::UserAuth
 * One user can link N external identities.
 */
export interface UserAuth {
  id: string;
  userId: string;
  /** e.g. 'oauth_github' | 'oauth_google' | 'oauth_generic' | 'saml' | 'ldap'. */
  authModule: string;
  /** External subject identifier (github numeric id, oidc sub, etc.). */
  authId: string;
  created: string;
  /** Encrypted at rest. */
  oAuthAccessToken: string | null;
  /** Encrypted at rest. */
  oAuthRefreshToken: string | null;
  oAuthTokenType: string | null;
  /** Epoch ms. */
  oAuthExpiry: number | null;
  /** Encrypted at rest. */
  oAuthIdToken: string | null;
}

export interface NewUserAuth {
  id?: string;
  userId: string;
  authModule: string;
  authId: string;
  oAuthAccessToken?: string | null;
  oAuthRefreshToken?: string | null;
  oAuthTokenType?: string | null;
  oAuthExpiry?: number | null;
  oAuthIdToken?: string | null;
}

/**
 * Grafana ref: pkg/services/auth/authimpl/user_auth_token.go::UserAuthToken
 * Server-side session record. Tokens are stored as SHA-256 hex — never plaintext.
 */
export interface UserAuthToken {
  id: string;
  userId: string;
  authToken: string;
  prevAuthToken: string;
  userAgent: string;
  clientIp: string;
  authTokenSeen: boolean;
  seenAt: string | null;
  rotatedAt: string;
  createdAt: string;
  updatedAt: string;
  /** null = active, non-null = soft-revoked (kept for audit). */
  revokedAt: string | null;
}

export interface NewUserAuthToken {
  id?: string;
  userId: string;
  authToken: string;
  prevAuthToken?: string;
  userAgent: string;
  clientIp: string;
  authTokenSeen?: boolean;
  seenAt?: string | null;
  rotatedAt?: string;
}
