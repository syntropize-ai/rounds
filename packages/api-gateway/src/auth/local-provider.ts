/**
 * Local username/password provider.
 *
 * Hashing: scrypt with N=16384, r=8, p=1, dkLen=64 (matches Grafana's
 * `pkg/services/login/authinfoimpl/store.go::HashPassword` parameters).
 * Stored format: `<salt_hex>:<hash_hex>` in `user.password`.
 *
 * Rate limiting: 5 failed attempts per (ip + login) in a 5-minute sliding
 * window; 6th attempt returns AuthError.rateLimited. In-memory only for now
 * (Redis / distributed rate limiting is a Phase 4+ concern).
 *
 * See docs/auth-perm-design/02-authentication.md §local-password-provider.
 */

import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { AuthError, type IUserRepository, type User } from '@agentic-obs/common';

/**
 * Promisified scrypt that accepts the options bag. `util.promisify(scrypt)` in
 * Node's typings doesn't carry the 4-arg overload, so we wrap manually.
 */
function scrypt(
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

// Grafana scrypt parameters — see comment at top of file.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

export const DEFAULT_PASSWORD_MIN_LENGTH = 12;

export function passwordMinLength(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const v = env['OPENOBS_PASSWORD_MIN_LENGTH'];
  if (!v) return DEFAULT_PASSWORD_MIN_LENGTH;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PASSWORD_MIN_LENGTH;
}

export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('hashPassword: password must be a non-empty string');
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    // Internal scrypt block-size * cost * parallelization product can exceed
    // the default 32MiB buffer on some hosts. Bump maxmem generously — scrypt
    // is memory-hard by design.
    maxmem: 64 * 1024 * 1024,
  });
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':', 2);
  if (!saltHex || !hashHex) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  const salt = Buffer.from(saltHex, 'hex');
  try {
    const derived = await scrypt(password, salt, expected.length, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: 64 * 1024 * 1024,
    });
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// — Rate limiter: sliding window, in-memory ———————————————————————————

interface RateWindow {
  attempts: number[];
}

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

export class LoginRateLimiter {
  private readonly windows = new Map<string, RateWindow>();

  constructor(
    private readonly max = RATE_LIMIT_MAX,
    private readonly windowMs = RATE_LIMIT_WINDOW_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private key(ip: string, userLogin: string): string {
    return `${ip ?? '-'}|${userLogin.toLowerCase()}`;
  }

  /**
   * Returns true when the caller is over the limit. Callers should check
   * BEFORE attempting verification so we don't do scrypt on abusive traffic.
   */
  isBlocked(ip: string, userLogin: string): boolean {
    const k = this.key(ip, userLogin);
    const w = this.windows.get(k);
    if (!w) return false;
    const cutoff = this.now() - this.windowMs;
    w.attempts = w.attempts.filter((t) => t > cutoff);
    if (w.attempts.length === 0) this.windows.delete(k);
    return w.attempts.length >= this.max;
  }

  /**
   * Milliseconds remaining until the (ip, userLogin) lockout window slides
   * off its oldest attempt. Returns 0 when not currently blocked.
   *
   * The unlock moment is `oldest + windowMs`. Once that passes, the oldest
   * attempt leaves the window and `isBlocked` flips false.
   */
  retryAfterMs(ip: string, userLogin: string): number {
    const k = this.key(ip, userLogin);
    const w = this.windows.get(k);
    if (!w) return 0;
    const now = this.now();
    const cutoff = now - this.windowMs;
    const active = w.attempts.filter((t) => t > cutoff);
    if (active.length < this.max) return 0;
    const oldest = active[0];
    if (oldest === undefined) return 0;
    const unlockAt = oldest + this.windowMs;
    return Math.max(0, unlockAt - now);
  }

  /** Record a failed attempt — slides the window. */
  recordFailure(ip: string, userLogin: string): void {
    const k = this.key(ip, userLogin);
    const w = this.windows.get(k) ?? { attempts: [] };
    w.attempts.push(this.now());
    this.windows.set(k, w);
  }

  /** Clear all attempts for (ip, userLogin) on success. */
  reset(ip: string, userLogin: string): void {
    this.windows.delete(this.key(ip, userLogin));
  }

  /** Test helper: wipe all state. */
  clear(): void {
    this.windows.clear();
  }
}

export interface LocalLoginInput {
  user: string;
  password: string;
  ip: string;
  userAgent: string;
}

export interface LocalLoginResult {
  user: User;
}

/**
 * LocalProvider: resolves (user, password) against the persisted user row.
 *
 * Does NOT issue the session cookie — that's the caller's job (via
 * `SessionService.create`). Returning only the user keeps the provider
 * compositional: LDAP/SAML/OAuth providers return the same shape.
 */
export class LocalProvider {
  constructor(
    private readonly users: IUserRepository,
    private readonly rateLimiter: LoginRateLimiter = new LoginRateLimiter(),
  ) {}

  async login(input: LocalLoginInput): Promise<LocalLoginResult> {
    const { user: login, password, ip } = input;
    if (!login || !password) {
      throw AuthError.invalidCredentials();
    }
    if (this.rateLimiter.isBlocked(ip, login)) {
      const retryAfterMs = this.rateLimiter.retryAfterMs(ip, login);
      throw AuthError.rateLimited(Math.ceil(retryAfterMs / 1000));
    }

    // Look up by login OR email. Both are unique-indexed so both are cheap.
    const candidate =
      (await this.users.findByLogin(login)) ??
      (await this.users.findByEmail(login));

    // IMPORTANT: any branch that would leak whether the user exists must
    // use the same error message as invalidCredentials(). Don't short-circuit
    // the scrypt call either — it smooths timing even when we already know
    // the account isn't usable. (We do skip when there's no password set
    // because there's nothing to verify against, but the thrown error is
    // still generic.)
    if (!candidate) {
      this.rateLimiter.recordFailure(ip, login);
      throw AuthError.invalidCredentials();
    }
    if (candidate.isDisabled) {
      // Don't disclose "user disabled" — same generic 401.
      this.rateLimiter.recordFailure(ip, login);
      throw AuthError.invalidCredentials();
    }
    if (candidate.isServiceAccount) {
      // Service accounts don't log in with a password.
      this.rateLimiter.recordFailure(ip, login);
      throw AuthError.invalidCredentials();
    }
    if (!candidate.password) {
      this.rateLimiter.recordFailure(ip, login);
      throw AuthError.invalidCredentials();
    }
    const ok = await verifyPassword(password, candidate.password);
    if (!ok) {
      this.rateLimiter.recordFailure(ip, login);
      throw AuthError.invalidCredentials();
    }
    this.rateLimiter.reset(ip, login);
    return { user: candidate };
  }
}
