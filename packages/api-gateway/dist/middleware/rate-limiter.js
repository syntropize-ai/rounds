export function createRateLimiter(options) {
    const { windowMs, max, keyFn } = options;
    const store = new Map();
    function getKey(req) {
        if (keyFn)
            return keyFn(req);
        const forwarded = req.headers['x-forwarded-for'];
        const ip = typeof forwarded === 'string'
            ? forwarded.split(',')[0]?.trim()
            : req.socket.remoteAddress ?? 'unknown';
        return ip ?? 'unknown';
    }
    return function rateLimiter(req, res, next) {
        const key = getKey(req);
        const now = Date.now();
        const windowStart = now - windowMs;
        let entry = store.get(key);
        if (!entry) {
            entry = { timestamps: [] };
            store.set(key, entry);
        }
        // Sliding window: remove timestamps outside the window
        entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
        if (entry.timestamps.length >= max) {
            const oldestInWindow = entry.timestamps[0];
            const retryAfterMs = oldestInWindow !== undefined ? oldestInWindow + windowMs - now : windowMs;
            res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000));
            res.setHeader('X-RateLimit-Limit', max);
            res.setHeader('X-RateLimit-Remaining', 0);
            const error = { code: 'RATE_LIMITED', message: 'Too many requests' };
            res.status(429).json(error);
            return;
        }
        entry.timestamps.push(now);
        res.setHeader('X-RateLimit-Limit', max);
        res.setHeader('X-RateLimit-Remaining', max - entry.timestamps.length);
        next();
    };
}
export const defaultRateLimiter = createRateLimiter({
    windowMs: 60_000, // 1 minute
    max: 100,
});
//# sourceMappingURL=rate-limiter.js.map