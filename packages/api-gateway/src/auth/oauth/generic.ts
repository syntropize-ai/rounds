/**
 * Generic OpenID Connect provider.
 *
 * Config env vars:
 *   OAUTH_GENERIC_CLIENT_ID
 *   OAUTH_GENERIC_CLIENT_SECRET
 *   OAUTH_GENERIC_REDIRECT_URI
 *   OAUTH_GENERIC_SCOPES            (default 'openid,email,profile')
 *   OAUTH_GENERIC_ALLOW_SIGN_UP     (true|false)
 *   OAUTH_GENERIC_DISPLAY_NAME      (shown on login page; default 'OIDC')
 *
 * Either supply full endpoints:
 *   OAUTH_GENERIC_AUTH_URL
 *   OAUTH_GENERIC_TOKEN_URL
 *   OAUTH_GENERIC_USERINFO_URL
 *
 * Or use Discovery:
 *   OAUTH_GENERIC_ISSUER_URL       (auto-fetches .well-known/openid-configuration)
 *
 * Attribute mapping:
 *   OAUTH_GENERIC_EMAIL_ATTRIBUTE  (default 'email')
 *   OAUTH_GENERIC_NAME_ATTRIBUTE   (default 'name')
 *   OAUTH_GENERIC_LOGIN_ATTRIBUTE  (default 'preferred_username')
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
import { ensureSafeUrl } from '../../utils/url-validator.js';

export interface GenericOidcConfig extends OAuthProviderConfig {
  module: 'oauth_generic';
  authUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  emailAttribute: string;
  nameAttribute: string;
  loginAttribute: string;
}

interface DiscoveryDoc {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  issuer?: string;
}

export async function loadGenericOidcConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GenericOidcConfig | null> {
  const clientId = env['OAUTH_GENERIC_CLIENT_ID'];
  const clientSecret = env['OAUTH_GENERIC_CLIENT_SECRET'];
  const redirectUri = env['OAUTH_GENERIC_REDIRECT_URI'];
  if (!clientId || !clientSecret || !redirectUri) return null;

  let authUrl = env['OAUTH_GENERIC_AUTH_URL'];
  let tokenUrl = env['OAUTH_GENERIC_TOKEN_URL'];
  let userinfoUrl = env['OAUTH_GENERIC_USERINFO_URL'];
  const issuerUrl = env['OAUTH_GENERIC_ISSUER_URL'];

  if ((!authUrl || !tokenUrl || !userinfoUrl) && issuerUrl) {
    const disc = await fetchDiscovery(issuerUrl);
    authUrl = authUrl || disc.authorization_endpoint;
    tokenUrl = tokenUrl || disc.token_endpoint;
    userinfoUrl = userinfoUrl || disc.userinfo_endpoint;
  }
  if (!authUrl || !tokenUrl || !userinfoUrl) return null;

  const scopes = (env['OAUTH_GENERIC_SCOPES'] ?? 'openid,email,profile')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return {
    module: 'oauth_generic',
    displayName: env['OAUTH_GENERIC_DISPLAY_NAME'] || 'OIDC',
    clientId,
    clientSecret,
    redirectUri,
    scopes,
    allowSignup: env['OAUTH_GENERIC_ALLOW_SIGN_UP'] === 'true',
    authUrl,
    tokenUrl,
    userinfoUrl,
    emailAttribute: env['OAUTH_GENERIC_EMAIL_ATTRIBUTE'] || 'email',
    nameAttribute: env['OAUTH_GENERIC_NAME_ATTRIBUTE'] || 'name',
    loginAttribute:
      env['OAUTH_GENERIC_LOGIN_ATTRIBUTE'] || 'preferred_username',
  };
}

export async function fetchDiscovery(issuerUrl: string): Promise<DiscoveryDoc> {
  const url = issuerUrl.endsWith('/')
    ? `${issuerUrl}.well-known/openid-configuration`
    : `${issuerUrl}/.well-known/openid-configuration`;
  // SSRF guard: the issuer URL is operator-configurable via
  // OAUTH_GENERIC_ISSUER_URL. In hardened (production) deployments this
  // rejects discovery pointed at internal services; in self-hosted mode it
  // allows loopback / RFC1918 per the default policy.
  await ensureSafeUrl(url);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`oidc discovery failed: ${res.status}`);
  }
  return (await res.json()) as DiscoveryDoc;
}

export class GenericOidcProvider {
  constructor(private readonly cfg: GenericOidcConfig) {}

  authorizeUrl(): { url: string; state: string } {
    const state = generateOAuthState();
    return {
      url: buildAuthorizeUrl(this.cfg, state, this.cfg.authUrl),
      state,
    };
  }

  async handleCallback(
    code: string,
    state: string,
    cookieHeader: string | undefined,
    deps: ResolveIdentityDeps,
  ): Promise<OAuthIdentityResolution> {
    const expected = readStateCookie(cookieHeader, 'oauth_generic');
    if (!expected || expected !== state) {
      throw AuthError.stateMismatch();
    }
    const tokens = await exchangeCodeForTokens({
      code,
      cfg: this.cfg,
      tokenEndpoint: this.cfg.tokenUrl,
    });
    const info = await this.fetchUserInfo(tokens.accessToken);
    return resolveIdentity(info, this.cfg, tokens, deps);
  }

  private async fetchUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    const res = await fetch(this.cfg.userinfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw AuthError.invalidToken(
        `generic oidc userinfo failed: ${res.status}`,
      );
    }
    const body = (await res.json()) as Record<string, unknown>;
    const sub = body['sub'];
    const email = body[this.cfg.emailAttribute];
    if (typeof sub !== 'string' || typeof email !== 'string') {
      throw AuthError.invalidCredentials();
    }
    // A provider saying the address is unverified is telling us not to trust
    // it, so refuse outright rather than continuing with a claim its own
    // issuer disowns.
    const claim = body['email_verified'];
    if (claim === false || claim === 'false') {
      throw AuthError.invalidCredentials();
    }
    // Absence is not an assertion. Many OIDC deployments simply omit the
    // claim, and those still sign in and can create an account — they just
    // cannot take over one that already exists (see `base.ts`).
    const emailVerified = claim === true || claim === 'true';
    return {
      module: 'oauth_generic',
      authId: sub,
      email,
      emailVerified,
      name: (body[this.cfg.nameAttribute] as string) || email,
      login:
        (body[this.cfg.loginAttribute] as string | undefined) ||
        email.split('@')[0],
    };
  }
}
