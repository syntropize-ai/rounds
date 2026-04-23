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
}

export function createRateLimiter(options: RateLimiterOptions) {
  const { windowMs, max, keyFn } = options
  const store = new Map<string, WindowEntry>()

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
      entry = { timestamps: [] }
      store.set(key, entry)
    }

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
