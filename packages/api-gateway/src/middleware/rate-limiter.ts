import type { Request, Response, NextFunction } from 'express'
import type { ApiErrorResponse } from '@agentic-obs/common'

interface RateLimiterOptions {
  windowMs: number
  max: number
  keyFn?: (req: Request) => string
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

  function getKey(req: Request): string {
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

export const defaultRateLimiter = createRateLimiter({
  windowMs: 60_000, // 1 minute
  max: 100,
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
