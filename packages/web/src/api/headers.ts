import { UnauthorizedError } from './transport.js';

const CSRF_COOKIE_NAME = 'openobs_csrf';
const CSRF_HEADER_NAME = 'X-CSRF-Token';
const NON_MUTATING_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Read a cookie value by name from `document.cookie`. Returns `null` if the
 * cookie is missing or `document` is unavailable (SSR / test envs).
 *
 * The CSRF cookie is intentionally NOT HttpOnly — see backend
 * `middleware/csrf.ts` for the double-submit cookie rationale.
 */
export function readBrowserCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const prefix = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return null;
}

/**
 * Build the headers needed for CSRF on state-changing requests. Returns an
 * empty object for safe methods or when no CSRF cookie is present (e.g. the
 * very first request after login — backend mints the cookie on that
 * response, the next request will include it).
 */
export function csrfHeaders(method: string): Record<string, string> {
  if (NON_MUTATING_METHODS.has(method.toUpperCase())) return {};
  const token = readBrowserCookie(CSRF_COOKIE_NAME);
  if (!token) return {};
  return { [CSRF_HEADER_NAME]: token };
}

/** Build auth headers from localStorage JWT or API key (legacy paths). */
export function authHeaders(): Record<string, string> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem('agentic_obs_auth');
  } catch (err) {
    // localStorage can throw in privacy-mode iframes / disabled storage.
    // Fall through to the api_key lookup below.
    console.warn('[api] localStorage.getItem(agentic_obs_auth) threw:', err);
  }
  if (raw) {
    try {
      const tokens = JSON.parse(raw) as { tokens?: { accessToken?: string } };
      if (tokens?.tokens?.accessToken) return { Authorization: `Bearer ${tokens.tokens.accessToken}` };
    } catch (err) {
      // A malformed token blob means this session is wedged — the user will
      // get 401s on every request with no way to recover short of clearing
      // storage manually. Throw UnauthorizedError; the transport layer
      // surfaces it to the registered auth-boundary handler, which clears
      // storage and redirects. Keeping side effects out of header decoding
      // means this function stays pure-ish and node-testable.
      console.warn('[api] auth token blob in localStorage is malformed', err);
      throw new UnauthorizedError('Malformed auth token blob');
    }
  }
  // Fall back to API key from localStorage (set during setup or login)
  try {
    const apiKey = localStorage.getItem('api_key');
    if (apiKey) return { 'x-api-key': apiKey };
  } catch (err) {
    console.warn('[api] localStorage.getItem(api_key) threw:', err);
  }
  return {};
}
