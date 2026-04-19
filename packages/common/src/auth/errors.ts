/**
 * Typed errors raised by auth providers and the auth middleware.
 *
 * Handlers map these to HTTP responses per docs/auth-perm-design/02-authentication.md
 * and docs/auth-perm-design/08-api-surface.md. Message strings are generic —
 * callers must NOT disclose which of "wrong user" vs "wrong password" failed
 * (timing-safe message policy).
 */

export type AuthErrorKind =
  | 'invalid_credentials'
  | 'rate_limited'
  | 'user_disabled'
  | 'provider_not_configured'
  | 'provider_no_signup'
  | 'state_mismatch'
  | 'invalid_token'
  | 'session_expired'
  | 'session_revoked'
  | 'internal';

export class AuthError extends Error {
  public readonly kind: AuthErrorKind;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;

  constructor(
    kind: AuthErrorKind,
    message: string,
    statusCode: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AuthError';
    this.kind = kind;
    this.statusCode = statusCode;
    this.details = details;
  }

  static invalidCredentials(): AuthError {
    return new AuthError(
      'invalid_credentials',
      'invalid username or password',
      401,
    );
  }

  /**
   * Rate-limited / account lockout. When `retryAfterSeconds` is provided the
   * caller can render a `Retry-After` header; HTTP handlers reach it via
   * `err.details.retryAfterSeconds`.
   */
  static rateLimited(retryAfterSeconds?: number): AuthError {
    return new AuthError(
      'rate_limited',
      'too many login attempts',
      429,
      typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds)
        ? { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)) }
        : undefined,
    );
  }

  static userDisabled(): AuthError {
    // Same message as invalid_credentials so attacker can't enumerate.
    return new AuthError(
      'user_disabled',
      'invalid username or password',
      401,
    );
  }

  static providerNotConfigured(provider: string): AuthError {
    return new AuthError(
      'provider_not_configured',
      `provider ${provider} is not configured`,
      501,
    );
  }

  static providerNoSignup(provider: string): AuthError {
    return new AuthError(
      'provider_no_signup',
      `signup via ${provider} is disabled`,
      403,
    );
  }

  static stateMismatch(): AuthError {
    return new AuthError('state_mismatch', 'invalid oauth state', 400);
  }

  static invalidToken(reason = 'invalid token'): AuthError {
    return new AuthError('invalid_token', reason, 401);
  }

  static sessionExpired(): AuthError {
    return new AuthError('session_expired', 'session expired', 401);
  }

  static sessionRevoked(): AuthError {
    return new AuthError('session_revoked', 'session revoked', 401);
  }

  static internal(message = 'internal auth error'): AuthError {
    return new AuthError('internal', message, 500);
  }
}
