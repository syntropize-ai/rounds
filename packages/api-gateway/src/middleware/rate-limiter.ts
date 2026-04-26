import type { Request, Response, NextFunction } from 'express'
import type { ApiErrorResponse } from '@agentic-obs/common'
import type { AuthenticatedRequest } from './auth.js'

interface RateLimiterOptions {
  windowMs: number
  max: number
  /**
   * Custom key extractor. Return a string to key the limiter on that value,
   * or `null` to **skip** this request entirely (pass-through to `next()`).
   * When omitted, the limiter falls back to a per-IP key derived from
   * x-forwarded-for / socket.remoteAddress.
   */
  keyFn?: (req: Request) => string | null
}

export type RateLimiterMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void

interface WindowEntry {
  timestamps: number[]
  /** Last activity ms — used by the periodic janitor to evict idle keys. */
  lastSeen: number
}

/**
 * Cleanup interval used by every limiter: periodically drops entries whose
 * `lastSeen` is older than `windowMs * 2`. Without this the Map grows
 * unbounded as new IPs / userIds keep arriving.
 *
 * The interval is `unref()`'d so it never holds the process alive in tests.
 */
const CLEANUP_INTERVAL_MS = 60_000

export function createRateLimiter(options: RateLimiterOptions) {
  const { windowMs, max, keyFn } = options
  const store = new Map<string, WindowEntry>()

  // Periodic janitor — evict any key whose last hit is older than 2*windowMs.
  // After that gap the bucket is fully empty (sliding window discards
  // anything older than `windowMs`), so dropping the key is lossless.
  const cleanupInterval = setInterval(() => {
    const cutoff = Date.now() - windowMs * 2
    for (const [k, v] of store) {
      if (v.lastSeen < cutoff) store.delete(k)
    }
  }, CLEANUP_INTERVAL_MS)
  if (typeof cleanupInterval.unref === 'function') cleanupInterval.unref()

  function getKey(req: Request): string | null {
    if (keyFn)
      return keyFn(req)
    const forwarded = req.headers['x-forwarded-for']
    const ip = typeof forwarded === 'string'
      ? forwarded.split(',')[0]?.trim()
      : req.socket.remoteAddress ?? 'unknown'
    return ip ?? 'unknown'
  }

  return function rateLimiter(req: Request, res: Response, next: NextFunction): void {
    const key = getKey(req)
    // `null` key = skip the limiter entirely (e.g. pre-auth request hitting
    // the per-user limiter before `req.auth` has been populated).
    if (key === null) {
      next()
      return
    }
    const now = Date.now()
    const windowStart = now - windowMs

    let entry = store.get(key)
    if (!entry) {
      entry = { timestamps: [], lastSeen: now }
      store.set(key, entry)
    }
    entry.lastSeen = now

    // Sliding window: remove timestamps outside the window
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart)
    if (entry.timestamps.length >= max) {
      const oldestInWindow = entry.timestamps[0]
      const retryAfterMs = oldestInWindow !== undefined ? oldestInWindow + windowMs - now : windowMs
      res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000))
      res.setHeader('X-RateLimit-Limit', max)
      res.setHeader('X-RateLimit-Remaining', 0)
      const body: ApiErrorResponse = {
        error: { code: 'RATE_LIMITED', message: 'Too many requests' },
      }
      res.status(429).json(body)
      return
    }

    entry.timestamps.push(now)
    res.setHeader('X-RateLimit-Limit', max)
    res.setHeader('X-RateLimit-Remaining', max - entry.timestamps.length)
    next()
  }
}

/**
 * Global per-IP limiter. Sized for an active session (an authed user
 * opening a dashboard page triggers a dozen initial fetches, and the
 * orchestrator agent burns through more as it runs tool calls), not
 * for "one request per typed action". 600/min ≈ 10 req/s steady-state
 * with room for bursts, same ceiling as /api/query. Operators running
 * multi-tenant SaaS should tighten via OPENOBS_RATE_LIMIT_MAX; behind
 * a shared NAT this stays per-IP, so per-user rate limits are a
 * layered follow-up.
 */
const DEFAULT_RATE_LIMIT_MAX = Number.parseInt(
  process.env['OPENOBS_RATE_LIMIT_MAX'] ?? '600',
  10,
);
export const defaultRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: Number.isFinite(DEFAULT_RATE_LIMIT_MAX) && DEFAULT_RATE_LIMIT_MAX > 0
    ? DEFAULT_RATE_LIMIT_MAX
    : 600,
})

/**
 * Strict limiter for unauthenticated credential-handling endpoints
 * (`POST /api/login`, `POST /api/setup/admin`). Per-IP because pre-auth we
 * have no user identity; the internal LocalProvider also enforces a
 * per-(ip, login) lockout downstream.
 *
 * 10 req/min per IP — generous enough for a human fat-fingering the password
 * a few times, tight enough to slow online-guessing traffic before the 5/5min
 * per-(ip, login) lockout even engages.
 */
export const loginRateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 10,
})

/**
 * Per-user rate limiter, layered on top of the per-IP `defaultRateLimiter`.
 *
 * Rationale: behind a shared NAT (corporate office, residential CGNAT,
 * container egress, etc.) every user looks like the same source IP to the
 * per-IP limiter, so one noisy tab can starve everyone else on the same
 * egress. Keying on `req.auth.userId` gives each authenticated user their
 * own bucket regardless of upstream IP.
 *
 * This MUST be mounted **after** `authMiddleware` — unauthenticated requests
 * have no `req.auth` and fall through (`keyFn` returns `null`). The per-IP
 * limiter already throttles the pre-auth surface.
 *
 * Tune with `OPENOBS_USER_RATE_LIMIT_MAX` (default 600/min, parallel to
 * `OPENOBS_RATE_LIMIT_MAX`). Operators running multi-tenant SaaS should
 * usually set this LOWER than the IP limit — the IP limit protects the
 * pre-auth surface, the per-user limit protects one user from another.
 */
const DEFAULT_USER_RATE_LIMIT_MAX = Number.parseInt(
  process.env['OPENOBS_USER_RATE_LIMIT_MAX'] ?? '600',
  10,
);

export function createUserRateLimiter() {
  const max =
    Number.isFinite(DEFAULT_USER_RATE_LIMIT_MAX) && DEFAULT_USER_RATE_LIMIT_MAX > 0
      ? DEFAULT_USER_RATE_LIMIT_MAX
      : 600
  return createRateLimiter({
    windowMs: 60_000,
    max,
    keyFn: (req) => {
      // Auth middleware populates `req.auth` when a session/api-key is
      // present. Casting is safe: this limiter is only mounted on routes
      // that run AFTER the auth middleware (which uses the same type).
      const auth = (req as AuthenticatedRequest).auth
      return auth?.userId ?? null
    },
  })
}

/**
 * Strict per-user limiter for endpoints that mint long-lived credentials
 * (`POST /api/serviceaccounts/:id/tokens`, `POST /api/auth/keys`).
 *
 * 5 issuances per minute per authenticated user — orders of magnitude lower
 * than the default 600/min user bucket because each successful call returns a
 * full bearer token. Leaks one of these is an account compromise; throttling
 * stops a stolen session from minting hundreds of persistent keys before the
 * legitimate owner can react.
 *
 * Mount AFTER `authMw` so `req.auth.userId` is populated. If the request
 * arrives without auth (a routing bug — these routes are already auth-gated)
 * we reject 401 rather than fall through, since per-IP keying would let an
 * attacker share quota across stolen IPs.
 */
export const TOKEN_ISSUE_RATE_LIMIT_MAX = 5

export function createTokenIssueRateLimiter() {
  return createRateLimiter({
    windowMs: 60_000,
    max: TOKEN_ISSUE_RATE_LIMIT_MAX,
    keyFn: (req) => {
      const auth = (req as AuthenticatedRequest).auth
      // No-auth callers are rejected by the wrapper below; returning a
      // sentinel here keeps the rate-limiter's contract clean (the wrapper
      // intercepts before this is ever reached, but defence-in-depth).
      return auth?.userId ?? '__unauth__'
    },
  })
}

/**
 * Wraps `createTokenIssueRateLimiter` with a defensive 401 for unauthed
 * requests. Real production traffic should never hit this path because the
 * routes are already auth-gated, but if a future refactor reorders middleware
 * we'd rather fail closed than let an unauth caller share an unbounded bucket.
 */
export const tokenIssueRateLimiter: RateLimiterMiddleware = (() => {
  const inner = createTokenIssueRateLimiter()
  return (req, res, next) => {
    const auth = (req as AuthenticatedRequest).auth
    if (!auth?.userId) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'authentication required' },
      })
      return
    }
    inner(req, res, next)
  }
})()
