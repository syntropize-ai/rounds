/**
 * GitHub OAuth provider.
 *
 * Config env vars (see docs/auth-perm-design/02-authentication.md §oauth-providers):
 *   OAUTH_GITHUB_CLIENT_ID
 *   OAUTH_GITHUB_CLIENT_SECRET
 *   OAUTH_GITHUB_REDIRECT_URI
 *   OAUTH_GITHUB_SCOPES            (comma-separated; default 'read:user,user:email')
 *   OAUTH_GITHUB_ALLOW_SIGN_UP     (true|false; default false)
 *   OAUTH_GITHUB_ALLOWED_ORGANIZATIONS (comma-separated org slugs)
 *
 * GitHub specifics:
 *   - `/user` returns profile but email may be null when the user hides it;
 *     `/user/emails` returns all emails including verification status. We use
 *     the primary verified one.
 *   - GitHub `id` is a numeric integer; stored as string for type parity.
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

const GITHUB_AUTH_ENDPOINT = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_ENDPOINT = 'https://api.github.com/user';
const GITHUB_USER_EMAILS_ENDPOINT = 'https://api.github.com/user/emails';
const GITHUB_USER_ORGS_ENDPOINT = 'https://api.github.com/user/orgs';

export interface GitHubProviderConfig extends OAuthProviderConfig {
  module: 'oauth_github';
}

export function loadGitHubConfig(
  env: NodeJS.ProcessEnv = process.env,
): GitHubProviderConfig | null {
  const clientId = env['OAUTH_GITHUB_CLIENT_ID'];
  const clientSecret = env['OAUTH_GITHUB_CLIENT_SECRET'];
  const redirectUri = env['OAUTH_GITHUB_REDIRECT_URI'];
  if (!clientId || !clientSecret || !redirectUri) return null;
  const scopes = (env['OAUTH_GITHUB_SCOPES'] ?? 'read:user,user:email')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    module: 'oauth_github',
    displayName: 'GitHub',
    clientId,
    clientSecret,
    redirectUri,
    scopes,
    allowSignup: env['OAUTH_GITHUB_ALLOW_SIGN_UP'] === 'true',
    allowedOrganizations: (env['OAUTH_GITHUB_ALLOWED_ORGANIZATIONS'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  };
}

export class GitHubProvider {
  constructor(private readonly cfg: GitHubProviderConfig) {}

  authorizeUrl(): { url: string; state: string } {
    const state = generateOAuthState();
    return {
      url: buildAuthorizeUrl(this.cfg, state, GITHUB_AUTH_ENDPOINT),
      state,
    };
  }

  async handleCallback(
    code: string,
    state: string,
    cookieHeader: string | undefined,
    deps: ResolveIdentityDeps,
  ): Promise<OAuthIdentityResolution> {
    const expected = readStateCookie(cookieHeader, 'oauth_github');
    if (!expected || expected !== state) {
      throw AuthError.stateMismatch();
    }
    const tokens = await exchangeCodeForTokens({
      code,
      cfg: this.cfg,
      tokenEndpoint: GITHUB_TOKEN_ENDPOINT,
    });
    const info = await this.fetchUserInfo(tokens.accessToken);
    if (this.cfg.allowedOrganizations && this.cfg.allowedOrganizations.length > 0) {
      await this.ensureOrgMembership(tokens.accessToken);
    }
    return resolveIdentity(info, this.cfg, tokens, deps);
  }

  private async fetchUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'rounds',
    };
    const userRes = await fetch(GITHUB_USER_ENDPOINT, { headers });
    if (!userRes.ok) {
      throw AuthError.invalidToken(`github /user failed: ${userRes.status}`);
    }
    const profile = (await userRes.json()) as Record<string, unknown>;
    let email = typeof profile['email'] === 'string' ? (profile['email'] as string) : null;
    if (!email) {
      const emailsRes = await fetch(GITHUB_USER_EMAILS_ENDPOINT, { headers });
      if (emailsRes.ok) {
        const emails = (await emailsRes.json()) as Array<{
          email: string;
          primary: boolean;
          verified: boolean;
        }>;
        const primary = emails.find((e) => e.primary && e.verified);
        email = primary?.email ?? emails.find((e) => e.verified)?.email ?? null;
      }
    }
    if (!email) {
      throw AuthError.invalidCredentials();
    }
    return {
      module: 'oauth_github',
      // GitHub id is numeric; store as string per schema.
      authId: String(profile['id'] ?? ''),
      email,
      // Both sources above are verified addresses: the fallback filters on
      // `verified`, and GitHub does not let an unverified address be the
      // public profile email.
      emailVerified: true,
      name:
        (profile['name'] as string | null) ||
        (profile['login'] as string) ||
        email,
      login: profile['login'] as string | undefined,
      avatarUrl: profile['avatar_url'] as string | undefined,
    };
  }

  private async ensureOrgMembership(accessToken: string): Promise<void> {
    const res = await fetch(GITHUB_USER_ORGS_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'rounds',
      },
    });
    if (!res.ok) {
      throw AuthError.invalidCredentials();
    }
    const orgs = (await res.json()) as Array<{ login: string }>;
    const allowed = new Set(
      (this.cfg.allowedOrganizations ?? []).map((s) => s.toLowerCase()),
    );
    const hit = orgs.some((o) => allowed.has(o.login.toLowerCase()));
    if (!hit) {
      throw AuthError.providerNoSignup('oauth_github');
    }
  }
}
