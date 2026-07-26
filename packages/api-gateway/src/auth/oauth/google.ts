/**
 * Google OIDC provider.
 *
 * Config env vars:
 *   OAUTH_GOOGLE_CLIENT_ID
 *   OAUTH_GOOGLE_CLIENT_SECRET
 *   OAUTH_GOOGLE_REDIRECT_URI
 *   OAUTH_GOOGLE_SCOPES            (default 'openid,email,profile')
 *   OAUTH_GOOGLE_ALLOW_SIGN_UP     (true|false; default false)
 *   OAUTH_GOOGLE_ALLOWED_DOMAINS   (comma-separated; empty = any)
 *
 * Google specifics:
 *   - `email_verified` must be true in the id_token payload; unverified emails
 *     are rejected with invalidCredentials.
 *   - `sub` claim is the stable authId.
 */

import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  generateOAuthState,
  resolveIdentity,
  readStateCookie,
  type OAuthProviderConfig,
  type OAuthUserInfo,
  type ResolveIdentityDeps,
  type OAuthIdentityResolution,
} from './base.js';
import { AuthError } from '@agentic-obs/common';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

export interface GoogleProviderConfig extends OAuthProviderConfig {
  module: 'oauth_google';
}

export function loadGoogleConfig(
  env: NodeJS.ProcessEnv = process.env,
): GoogleProviderConfig | null {
  const clientId = env['OAUTH_GOOGLE_CLIENT_ID'];
  const clientSecret = env['OAUTH_GOOGLE_CLIENT_SECRET'];
  const redirectUri = env['OAUTH_GOOGLE_REDIRECT_URI'];
  if (!clientId || !clientSecret || !redirectUri) return null;
  const scopes = (env['OAUTH_GOOGLE_SCOPES'] ?? 'openid,email,profile')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    module: 'oauth_google',
    displayName: 'Google',
    clientId,
    clientSecret,
    redirectUri,
    scopes,
    allowSignup: env['OAUTH_GOOGLE_ALLOW_SIGN_UP'] === 'true',
    allowedDomains: (env['OAUTH_GOOGLE_ALLOWED_DOMAINS'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  };
}

export class GoogleProvider {
  constructor(private readonly cfg: GoogleProviderConfig) {}

  authorizeUrl(): { url: string; state: string } {
    const state = generateOAuthState();
    return {
      url: buildAuthorizeUrl(this.cfg, state, GOOGLE_AUTH_ENDPOINT),
      state,
    };
  }

  async handleCallback(
    code: string,
    state: string,
    cookieHeader: string | undefined,
    deps: ResolveIdentityDeps,
  ): Promise<OAuthIdentityResolution> {
    const expected = readStateCookie(cookieHeader, 'oauth_google');
    if (!expected || expected !== state) {
      throw AuthError.stateMismatch();
    }
    const tokens = await exchangeCodeForTokens({
      code,
      cfg: this.cfg,
      tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
    });
    const info = await this.fetchUserInfo(tokens.accessToken);
    // Domain allow-list.
    if (this.cfg.allowedDomains && this.cfg.allowedDomains.length > 0) {
      const domain = info.email.split('@')[1]?.toLowerCase() ?? '';
      const allowed = new Set(
        this.cfg.allowedDomains.map((d) => d.toLowerCase()),
      );
      if (!allowed.has(domain)) {
        throw AuthError.providerNoSignup('oauth_google');
      }
    }
    return resolveIdentity(info, this.cfg, tokens, deps);
  }

  private async fetchUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    const res = await fetch(GOOGLE_USERINFO_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw AuthError.invalidToken(
        `google userinfo failed: ${res.status}`,
      );
    }
    const body = (await res.json()) as Record<string, unknown>;
    const sub = body['sub'];
    const email = body['email'];
    const emailVerified = body['email_verified'];
    if (typeof sub !== 'string' || typeof email !== 'string') {
      throw AuthError.invalidCredentials();
    }
    // Google requires email_verified=true for OIDC sign-in per §02.
    if (emailVerified !== true && emailVerified !== 'true') {
      throw AuthError.invalidCredentials();
    }
    return {
      module: 'oauth_google',
      authId: sub,
      // Guaranteed by the check above, which rejects anything else.
      emailVerified: true,
      email,
      name: (body['name'] as string) || email,
      login: (body['email'] as string).split('@')[0],
      avatarUrl: body['picture'] as string | undefined,
    };
  }
}
