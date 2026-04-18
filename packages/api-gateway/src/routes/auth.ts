/**
 * /api/login, /api/login/:provider*, /api/logout, /api/saml/*
 *
 * Per docs/auth-perm-design/08-api-surface.md. Public endpoints — no auth
 * middleware attached. On successful login we set the `openobs_session`
 * cookie and audit-log the outcome.
 */

import { Router, type Request, type Response } from 'express';
import type {
  IOrgUserRepository,
  IUserAuthRepository,
  IUserRepository,
} from '@agentic-obs/common';
import { AuthError } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common';
import { AuditAction } from '@agentic-obs/common';
import { resolveSecretKey } from '@agentic-obs/common';
import type { AuditWriter } from '../auth/audit-writer.js';
import type { LocalProvider } from '../auth/local-provider.js';
import type { SessionService } from '../auth/session-service.js';
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  SESSION_COOKIE_NAME,
  shouldDropSecure,
} from '../auth/session-service.js';
import type {
  GenericOidcProvider,
  GitHubProvider,
  GoogleProvider,
  OAuthModule,
} from '../auth/oauth/index.js';
import {
  buildStateCookie,
} from '../auth/oauth/base.js';
import type { LdapProvider } from '../auth/ldap/provider.js';
import type { SamlProvider } from '../auth/saml/provider.js';
import { createAuthMiddleware, readCookie, type AuthenticatedRequest } from '../middleware/auth.js';

const log = createLogger('auth-routes');

export interface AuthRouterDeps {
  users: IUserRepository;
  userAuth: IUserAuthRepository;
  orgUsers: IOrgUserRepository;
  sessions: SessionService;
  local: LocalProvider;
  github?: GitHubProvider | null;
  google?: GoogleProvider | null;
  generic?: GenericOidcProvider | null;
  ldap?: LdapProvider | null;
  saml?: SamlProvider | null;
  audit: AuditWriter;
  defaultOrgId: string;
}

function secureCookie(): boolean {
  return !shouldDropSecure(process.env);
}

function setSessionCookie(res: Response, token: string): void {
  res.setHeader(
    'Set-Cookie',
    buildSessionCookie(token, {
      maxAgeSec: Math.floor(DEFAULT_SESSION_IDLE_TIMEOUT_MS / 1000),
      secure: secureCookie(),
    }),
  );
}

function clearSessionCookie(res: Response): void {
  res.setHeader(
    'Set-Cookie',
    buildClearedSessionCookie({ secure: secureCookie() }),
  );
}

function ip(req: Request): string {
  return req.ip ?? (req.socket.remoteAddress ?? '');
}

function ua(req: Request): string {
  const h = req.headers['user-agent'];
  return typeof h === 'string' ? h : '';
}

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const router = Router();

  // GET /api/login/providers — list enabled providers (public).
  router.get('/login/providers', (_req: Request, res: Response) => {
    const providers: Array<{ id: string; name: string; enabled: boolean; url?: string }> = [
      { id: 'local', name: 'Username / password', enabled: true },
    ];
    if (deps.github)
      providers.push({ id: 'github', name: 'GitHub', enabled: true, url: '/api/login/github' });
    if (deps.google)
      providers.push({ id: 'google', name: 'Google', enabled: true, url: '/api/login/google' });
    if (deps.generic)
      providers.push({ id: 'generic', name: 'OIDC', enabled: true, url: '/api/login/generic' });
    if (deps.ldap)
      providers.push({ id: 'ldap', name: 'LDAP', enabled: true });
    if (deps.saml)
      providers.push({ id: 'saml', name: 'SAML', enabled: true, url: '/api/saml/login' });
    res.json(providers);
  });

  // POST /api/login — local password, or LDAP when only LDAP is available.
  router.post('/login', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { user?: string; password?: string };
    const user = body.user;
    const password = body.password;
    if (!user || !password) {
      res.status(400).json({ message: 'user and password are required' });
      return;
    }
    // Service-account login guard (T6). The local-provider already rejects
    // SAs with a generic 401 for timing-safe uniformity; we front-run it
    // here with an explicit 403 when the supplied login looks up to a
    // service-account row. This satisfies the acceptance test in
    // docs/auth-perm-design/06-service-accounts.md §10 while preserving the
    // generic 401 for password-failure paths.
    try {
      const candidate =
        (await deps.users.findByLogin(user)) ??
        (await deps.users.findByEmail(user));
      if (candidate?.isServiceAccount) {
        void deps.audit.log({
          action: AuditAction.UserLoginFailed,
          actorType: 'user',
          actorName: user,
          outcome: 'failure',
          ip: ip(req),
          userAgent: ua(req),
          metadata: { reason: 'service_account_login' },
        });
        res.status(403).json({
          message: 'service accounts cannot log in interactively',
        });
        return;
      }
    } catch (err) {
      log.debug(
        { err: err instanceof Error ? err.message : err },
        'pre-login SA check failed',
      );
      // Fall through — the local-provider's own guard will still reject.
    }
    try {
      // Try LDAP first if configured; fall back to local on failure.
      let resolvedUser;
      if (deps.ldap) {
        try {
          const r = await deps.ldap.login({ user, password });
          resolvedUser = r.user;
        } catch {
          // fall through to local
        }
      }
      if (!resolvedUser) {
        const r = await deps.local.login({
          user,
          password,
          ip: ip(req),
          userAgent: ua(req),
        });
        resolvedUser = r.user;
      }
      const session = await deps.sessions.create(
        resolvedUser.id,
        ua(req),
        ip(req),
      );
      setSessionCookie(res, session.token);
      void deps.audit.log({
        action: AuditAction.UserLogin,
        actorType: 'user',
        actorId: resolvedUser.id,
        actorName: resolvedUser.login,
        orgId: resolvedUser.orgId,
        outcome: 'success',
        ip: ip(req),
        userAgent: ua(req),
      });
      res.status(200).json({ message: 'Logged in', redirectUrl: '/' });
    } catch (err) {
      if (err instanceof AuthError) {
        void deps.audit.log({
          action: AuditAction.UserLoginFailed,
          actorType: 'user',
          actorName: user,
          outcome: 'failure',
          ip: ip(req),
          userAgent: ua(req),
          metadata: { kind: err.kind },
        });
        res.status(err.statusCode).json({ message: err.message });
        return;
      }
      log.error(
        { err: err instanceof Error ? err.message : err },
        'login failed',
      );
      res.status(500).json({ message: 'internal auth error' });
    }
  });

  // GET /api/login/:provider — start OAuth flow.
  router.get('/login/:provider', (req: Request, res: Response) => {
    const provider = req.params['provider'];
    try {
      const p = getOAuthProvider(deps, provider);
      if (!p) {
        res
          .status(404)
          .json({ message: `provider ${provider} is not configured` });
        return;
      }
      const { url, state } = p.authorizeUrl();
      const moduleName = providerModule(provider);
      if (!moduleName) {
        res.status(400).json({ message: 'invalid provider' });
        return;
      }
      res.setHeader(
        'Set-Cookie',
        buildStateCookie(moduleName, state, secureCookie()),
      );
      res.redirect(url);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : err, provider },
        'oauth start failed',
      );
      res.status(500).json({ message: 'internal auth error' });
    }
  });

  // GET /api/login/:provider/callback — OAuth callback.
  router.get('/login/:provider/callback', async (req: Request, res: Response) => {
    const provider = req.params['provider'];
    const code = req.query['code'];
    const state = req.query['state'];
    if (typeof code !== 'string' || typeof state !== 'string') {
      res.status(400).json({ message: 'code and state are required' });
      return;
    }
    const p = getOAuthProvider(deps, provider);
    if (!p) {
      res.status(404).json({ message: 'provider not configured' });
      return;
    }
    try {
      const secretKey = resolveSecretKey();
      const result = await p.handleCallback(code, state, req.headers['cookie'], {
        users: deps.users,
        userAuth: deps.userAuth,
        secretKey,
        defaultOrgId: deps.defaultOrgId,
      });
      const session = await deps.sessions.create(
        result.user.id,
        ua(req),
        ip(req),
      );
      setSessionCookie(res, session.token);
      const auditAction = result.created
        ? AuditAction.UserCreated
        : result.linked
          ? AuditAction.UserAuthLinked
          : AuditAction.UserLogin;
      void deps.audit.log({
        action: auditAction,
        actorType: 'user',
        actorId: result.user.id,
        actorName: result.user.login,
        orgId: result.user.orgId,
        outcome: 'success',
        ip: ip(req),
        userAgent: ua(req),
        metadata: { provider },
      });
      res.redirect('/');
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.statusCode).json({ message: err.message });
        return;
      }
      log.error(
        { err: err instanceof Error ? err.message : err, provider },
        'oauth callback failed',
      );
      res.status(500).json({ message: 'internal auth error' });
    }
  });

  // POST /api/logout and GET /api/logout.
  const logoutHandler = async (req: Request, res: Response) => {
    const token = readCookie(req.headers['cookie'], SESSION_COOKIE_NAME);
    if (token) {
      const row = await deps.sessions.lookupByToken(token);
      if (row) {
        await deps.sessions.revoke(row.id);
        void deps.audit.log({
          action: AuditAction.UserLogout,
          actorType: 'user',
          actorId: row.userId,
          outcome: 'success',
          ip: ip(req),
          userAgent: ua(req),
        });
      }
    }
    clearSessionCookie(res);
    if (req.method === 'GET') {
      res.redirect('/login');
      return;
    }
    res.status(200).json({ message: 'Logged out' });
  };
  router.post('/logout', logoutHandler);
  router.get('/logout', logoutHandler);

  // SAML endpoints (501 when not configured).
  router.get('/saml/metadata', async (_req: Request, res: Response) => {
    if (!deps.saml) {
      res.status(501).json({ message: 'SAML not configured' });
      return;
    }
    const xml = await deps.saml.metadata();
    if (!xml) {
      res.status(501).json({ message: 'SAML toolkit unavailable' });
      return;
    }
    res.setHeader('Content-Type', 'application/xml');
    res.send(xml);
  });

  router.get('/saml/login', async (req: Request, res: Response) => {
    if (!deps.saml) {
      res.status(501).json({ message: 'SAML not configured' });
      return;
    }
    const url = await deps.saml.loginRedirectUrl(
      typeof req.query['relayState'] === 'string'
        ? (req.query['relayState'] as string)
        : undefined,
    );
    if (!url) {
      res.status(501).json({ message: 'SAML toolkit unavailable' });
      return;
    }
    res.redirect(url);
  });

  router.post('/saml/acs', async (req: Request, res: Response) => {
    if (!deps.saml) {
      res.status(501).json({ message: 'SAML not configured' });
      return;
    }
    try {
      const out = await deps.saml.consumeAssertion(
        req.body as Record<string, string | undefined>,
      );
      if (!out) {
        res.status(501).json({ message: 'SAML toolkit unavailable' });
        return;
      }
      const session = await deps.sessions.create(
        out.user.id,
        ua(req),
        ip(req),
      );
      setSessionCookie(res, session.token);
      void deps.audit.log({
        action: AuditAction.UserLogin,
        actorType: 'user',
        actorId: out.user.id,
        actorName: out.user.login,
        orgId: out.user.orgId,
        outcome: 'success',
        ip: ip(req),
        userAgent: ua(req),
        metadata: { method: 'saml' },
      });
      res.redirect('/');
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.statusCode).json({ message: err.message });
        return;
      }
      log.error(
        { err: err instanceof Error ? err.message : err },
        'saml acs failed',
      );
      res.status(500).json({ message: 'internal auth error' });
    }
  });

  router.get('/saml/slo', async (_req: Request, res: Response) => {
    if (!deps.saml) {
      res.status(501).json({ message: 'SAML not configured' });
      return;
    }
    res.status(501).json({ message: 'SAML SLO requires per-session context' });
  });

  router.post('/saml/slo/callback', (_req: Request, res: Response) => {
    res.status(200).json({ message: 'slo callback' });
  });

  return router;
}

function providerModule(provider: string | undefined): OAuthModule | null {
  if (provider === 'github') return 'oauth_github';
  if (provider === 'google') return 'oauth_google';
  if (provider === 'generic') return 'oauth_generic';
  return null;
}

function getOAuthProvider(
  deps: AuthRouterDeps,
  provider: string | undefined,
): GitHubProvider | GoogleProvider | GenericOidcProvider | null {
  if (provider === 'github') return deps.github ?? null;
  if (provider === 'google') return deps.google ?? null;
  if (provider === 'generic') return deps.generic ?? null;
  return null;
}

// Re-export for callers that compose the middleware alongside the router.
export { createAuthMiddleware };
export type { AuthenticatedRequest };
