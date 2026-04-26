/**
 * CSRF protection — double-submit cookie pattern.
 *
 * Why a tiny in-house impl rather than `csurf`?
 *   - `csurf` is unmaintained as of 2022 (deprecated by its author).
 *   - We only need the double-submit variant; pulling in a wrapper for one
 *     compare-strings operation is overkill.
 *
 * How it works:
 *   1. On every safe-method request that has a session cookie, ensure an
 *     `openobs_csrf` cookie is present. If missing, mint 32 random bytes hex
 *     and set it non-HttpOnly so the SPA's JS can read it.
 *   2. On state-changing requests (POST/PUT/PATCH/DELETE) we require the
 *     header `X-CSRF-Token` to match the cookie value byte-for-byte
 *     (constant-time compare).
 *   3. Bearer-token / x-api-key requests bypass — they don't ride a cookie
 *     so a cross-origin attacker can't replay them in the first place.
 *   4. First-contact auth endpoints (`/api/login`, `/api/setup/admin`,
 *     OAuth callbacks, SAML ACS) are exempted at the application level —
 *     they have their own CSRF mitigations (`state` param, SAML
 *     `RelayState`) and the user has no session cookie yet.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { readCookie } from './auth.js';
import { SESSION_COOKIE_NAME, shouldDropSecure } from '../auth/session-service.js';

export const CSRF_COOKIE_NAME = 'openobs_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Mint a fresh 32-byte random token, hex-encoded (64 chars). */
export function generateCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Build the Set-Cookie header value for the CSRF cookie. Note: NOT HttpOnly —
 * the SPA needs to read it via `document.cookie` to echo it in the header.
 * That's safe because the value is meaningless without the (HttpOnly) session
 * cookie — XSS already bypasses CSRF protection anyway.
 */
export function buildCsrfCookie(
  token: string,
  opts: { maxAgeSec?: number; secure?: boolean } = {},
): string {
  const parts = [
    `${CSRF_COOKIE_NAME}=${token}`,
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${opts.maxAgeSec ?? 60 * 60 * 24 * 7}`,
  ];
  if (opts.secure !== false) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Append a Set-Cookie header without clobbering any existing one. Express's
 * `res.setHeader('Set-Cookie', ...)` would overwrite the session cookie set
 * earlier in the response chain.
 */
function appendSetCookie(res: Response, value: string): void {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', value);
    return;
  }
  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, value]);
    return;
  }
  res.setHeader('Set-Cookie', [String(existing), value]);
}

function constantTimeEqual(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers. A length mismatch is
  // already a fail — short-circuit but in a way that still does fixed-length
  // work for the equal-length case.
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export interface CsrfMiddlewareOptions {
  /**
   * Exact paths that bypass CSRF entirely. Defaults cover the first-contact
   * auth endpoints — they have no session cookie yet, and carry their own
   * anti-CSRF (OAuth `state`, SAML `RelayState`).
   */
  exemptPaths?: Array<string | RegExp>;
}

// Exact-match exempt paths. A request must equal one of these strings exactly
// to bypass CSRF — `/api/login/foo` is NOT exempted by `/api/login`.
const DEFAULT_EXEMPT_EXACT: string[] = [
  '/api/login',
  '/api/logout',
  '/api/setup/admin',
  '/api/saml/login',
  '/api/saml/acs',
  '/api/saml/metadata',
  '/api/saml/slo',
];

// Regex-based exempt paths. Used for parameterized routes (OAuth provider
// start + callback) where the path varies but is intentionally exempt.
const DEFAULT_EXEMPT_REGEX: RegExp[] = [
  // `/api/login/:provider` and `/api/login/:provider/callback`.
  /^\/api\/login\/[^/]+(\/callback)?$/,
];

function isExempt(
  path: string,
  exemptExact: ReadonlySet<string>,
  exemptRegex: readonly RegExp[],
): boolean {
  if (exemptExact.has(path)) return true;
  for (const pat of exemptRegex) {
    if (pat.test(path)) return true;
  }
  return false;
}

/**
 * Express middleware that:
 *   - Issues an `openobs_csrf` cookie when the caller has a session cookie
 *     but no CSRF cookie yet (so the SPA gets one on first authenticated
 *     pageload). Safe methods pass through; non-safe methods fail closed.
 *   - On non-safe methods (POST/PUT/PATCH/DELETE), if the request is
 *     cookie-authed, requires the `X-CSRF-Token` header to match the cookie.
 *   - Skips entirely for bearer-token requests (no cookie => no CSRF risk)
 *     and exempt paths.
 */
export function createCsrfMiddleware(opts: CsrfMiddlewareOptions = {}) {
  const extra = opts.exemptPaths ?? [];
  const exemptExact = new Set<string>(DEFAULT_EXEMPT_EXACT);
  const exemptRegex: RegExp[] = [...DEFAULT_EXEMPT_REGEX];
  for (const pat of extra) {
    if (typeof pat === 'string') exemptExact.add(pat);
    else exemptRegex.push(pat);
  }

  return function csrfMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (isExempt(req.path, exemptExact, exemptRegex)) {
      next();
      return;
    }

    const cookieHeader = req.headers['cookie'];
    const sessionCookie = readCookie(cookieHeader, SESSION_COOKIE_NAME);
    const csrfCookie = readCookie(cookieHeader, CSRF_COOKIE_NAME);

    // Bearer-token (or x-api-key) authed requests — no session cookie ⇒ no
    // CSRF surface. Skip both issuance and verification.
    const auth = req.headers['authorization'];
    const xApiKey = req.headers['x-api-key'];
    const hasBearer =
      (typeof auth === 'string' && auth.startsWith('Bearer ')) ||
      (typeof xApiKey === 'string' && xApiKey.length > 0);
    if (hasBearer && !sessionCookie) {
      next();
      return;
    }

    // Issue CSRF cookie if a session is present but the CSRF cookie is missing.
    // This handles fresh logins, browsers that lost the cookie, etc.
    if (sessionCookie && !csrfCookie) {
      const token = generateCsrfToken();
      appendSetCookie(
        res,
        buildCsrfCookie(token, { secure: !shouldDropSecure(process.env) }),
      );
      // The cookie we just minted isn't visible to THIS request. Safe methods
      // can prime the browser for the next request, but state-changing
      // cookie-auth requests must fail closed instead of using first-request
      // token issuance as a bypass.
      if (SAFE_METHODS.has(req.method)) {
        next();
        return;
      }
      res.status(403).json({
        error: { code: 'CSRF_FAILED', message: 'invalid or missing CSRF token' },
      });
      return;
    }

    // Verification path — only for non-safe methods.
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    // No session cookie + non-bearer + non-safe method ⇒ unauth route, let
    // it through to the auth middleware which will 401.
    if (!sessionCookie) {
      next();
      return;
    }

    const headerToken = req.headers[CSRF_HEADER_NAME];
    const headerValue =
      typeof headerToken === 'string'
        ? headerToken
        : Array.isArray(headerToken)
          ? headerToken[0]
          : undefined;

    if (!headerValue || !csrfCookie || !constantTimeEqual(headerValue, csrfCookie)) {
      res.status(403).json({
        error: { code: 'CSRF_FAILED', message: 'invalid or missing CSRF token' },
      });
      return;
    }

    next();
  };
}
