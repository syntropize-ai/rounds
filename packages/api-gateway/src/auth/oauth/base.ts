/**
 * Shared OAuth 2.0 authorization-code flow helpers.
 *
 * Per-provider files (`github.ts`, `google.ts`, `generic.ts`) supply endpoint
 * URLs, scope defaults, and userinfo normalization. The state cookie, code
 * exchange, and resolveIdentity plumbing live here so providers stay small.
 *
 * Conceptually mirrors `pkg/services/authn/clients/oauth.go` in Grafana —
 * structure only, no verbatim port.
 *
 * See docs/auth-perm-design/02-authentication.md §oauth-providers.
 */

import { randomBytes } from 'node:crypto';
import type {
  IUserAuthRepository,
  IUserRepository,
  User,
} from '@agentic-obs/common';
import { AuthError } from '@agentic-obs/common';
import { encrypt } from '@agentic-obs/common/crypto';

export type OAuthModule = 'oauth_github' | 'oauth_google' | 'oauth_generic';

export interface OAuthProviderConfig {
  module: OAuthModule;
  displayName: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  allowSignup: boolean;
  /** Domain allow-list (Google) — empty array means unrestricted. */
  allowedDomains?: string[];
  /** Organization allow-list (GitHub) — empty array means unrestricted. */
  allowedOrganizations?: string[];
}

export interface OAuthUserInfo {
  module: OAuthModule;
  authId: string;
  email: string;
  name: string;
  login?: string;
  avatarUrl?: string;
  groups?: string[];
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string | null;
  idToken?: string | null;
  tokenType?: string | null;
  expiresAt?: number | null;
}

export interface OAuthIdentityResolution {
  user: User;
  linked: boolean;
  created: boolean;
}

export function generateOAuthState(): string {
  return randomBytes(16).toString('hex');
}

export const OAUTH_STATE_COOKIE_PREFIX = 'openobs_oauth_state_';
export const OAUTH_STATE_TTL_SEC = 10 * 60; // 10 minutes

export function stateCookieName(module: OAuthModule): string {
  return OAUTH_STATE_COOKIE_PREFIX + module;
}

export function buildStateCookie(
  module: OAuthModule,
  state: string,
  secure: boolean,
): string {
  const parts = [
    `${stateCookieName(module)}=${state}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${OAUTH_STATE_TTL_SEC}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function buildAuthorizeUrl(
  cfg: OAuthProviderConfig,
  state: string,
  authEndpoint: string,
): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes.join(' '),
    state,
    response_type: 'code',
  });
  return `${authEndpoint}?${params.toString()}`;
}

export interface TokenExchangeInput {
  code: string;
  cfg: OAuthProviderConfig;
  tokenEndpoint: string;
}

export async function exchangeCodeForTokens(
  input: TokenExchangeInput,
): Promise<OAuthTokenSet> {
  const { code, cfg, tokenEndpoint } = input;
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: cfg.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    throw AuthError.invalidToken(`oauth token exchange failed: ${res.status}`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  if (body['error']) {
    throw AuthError.invalidToken(`oauth error: ${String(body['error'])}`);
  }
  const accessToken = body['access_token'];
  if (typeof accessToken !== 'string' || !accessToken) {
    throw AuthError.invalidToken('oauth response missing access_token');
  }
  const expiresIn =
    typeof body['expires_in'] === 'number'
      ? (body['expires_in'] as number) * 1000
      : undefined;
  return {
    accessToken,
    refreshToken: (body['refresh_token'] as string | null | undefined) ?? null,
    idToken: (body['id_token'] as string | null | undefined) ?? null,
    tokenType: (body['token_type'] as string | null | undefined) ?? null,
    expiresAt: expiresIn ? Date.now() + expiresIn : null,
  };
}

export interface ResolveIdentityDeps {
  users: IUserRepository;
  userAuth: IUserAuthRepository;
  secretKey: string;
  defaultOrgId: string;
}

/**
 * resolveIdentity:
 *  1. user_auth lookup by (module, authId) — if found, return the linked user.
 *  2. fall back to email match; if found, link and return.
 *  3. if allow_signup is true, create a new user + user_auth row.
 *  4. else throw providerNoSignup.
 */
export async function resolveIdentity(
  info: OAuthUserInfo,
  cfg: OAuthProviderConfig,
  tokens: OAuthTokenSet,
  deps: ResolveIdentityDeps,
): Promise<OAuthIdentityResolution> {
  if (!info.email) {
    throw AuthError.invalidCredentials();
  }
  // Optional allow-list filters (Google allowedDomains, GitHub allowedOrgs
  // live in the provider-specific callers).
  const existing = await deps.userAuth.findByAuthInfo(info.module, info.authId);
  if (existing) {
    const linked = await deps.users.findById(existing.userId);
    if (!linked) {
      throw AuthError.internal('user_auth points to missing user');
    }
    await persistTokens(deps, existing.id, tokens);
    return { user: linked, linked: true, created: false };
  }

  // Email collision — link existing local user if present.
  const byEmail = await deps.users.findByEmail(info.email);
  if (byEmail) {
    const auth = await deps.userAuth.create({
      userId: byEmail.id,
      authModule: info.module,
      authId: info.authId,
    });
    await persistTokens(deps, auth.id, tokens);
    return { user: byEmail, linked: true, created: false };
  }

  if (!cfg.allowSignup) {
    throw AuthError.providerNoSignup(info.module);
  }

  // Create new user. `login` prefers provider-supplied username, falls back
  // to local-part of email. `name` defaults to the login when unset so we
  // never write an empty string.
  const login =
    info.login && info.login.length > 0
      ? info.login
      : info.email.split('@')[0]!;
  const created = await deps.users.create({
    email: info.email,
    name: info.name || login,
    login,
    orgId: deps.defaultOrgId,
    emailVerified: true,
  });
  const auth = await deps.userAuth.create({
    userId: created.id,
    authModule: info.module,
    authId: info.authId,
  });
  await persistTokens(deps, auth.id, tokens);
  return { user: created, linked: false, created: true };
}

async function persistTokens(
  deps: ResolveIdentityDeps,
  userAuthId: string,
  tokens: OAuthTokenSet,
): Promise<void> {
  await deps.userAuth.update(userAuthId, {
    oAuthAccessToken: tokens.accessToken
      ? encrypt(tokens.accessToken, deps.secretKey)
      : null,
    oAuthRefreshToken: tokens.refreshToken
      ? encrypt(tokens.refreshToken, deps.secretKey)
      : null,
    oAuthIdToken: tokens.idToken
      ? encrypt(tokens.idToken, deps.secretKey)
      : null,
    oAuthTokenType: tokens.tokenType ?? null,
    oAuthExpiry: tokens.expiresAt ?? null,
  });
}

/** Read the state cookie value for `module` out of a raw Cookie header. */
export function readStateCookie(
  cookieHeader: string | undefined,
  module: OAuthModule,
): string | null {
  if (!cookieHeader) return null;
  const name = stateCookieName(module);
  for (const part of cookieHeader.split(';')) {
    const [rawK, ...rest] = part.trim().split('=');
    if (rawK === name) {
      return rest.join('=') || null;
    }
  }
  return null;
}
