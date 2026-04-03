import corsLib from 'cors';
import { createLogger } from '@agentic-obs/common';
const log = createLogger('cors');
const isProd = process.env['NODE_ENV'] === 'production';
const rawOrigins = process.env['CORS_ORIGINS'] ?? '*';
const allowedOrigins = rawOrigins.split(',').map((o) => o.trim()).filter(Boolean);
if (isProd && allowedOrigins.includes('*')) {
    throw new Error('[cors] FATAL: CORS_ORIGINS must not be "*" in production. ' +
        'Set CORS_ORIGINS to a comma-separated list of allowed origins.');
}
if (!isProd && allowedOrigins.includes('*')) {
    log.warn('CORS is open to all origins ("*"). Restrict CORS_ORIGINS before deploying to production.');
}
const corsOptions = {
    origin: allowedOrigins.includes('*') ? true : allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
    credentials: !allowedOrigins.includes('*'),
};
export const cors = corsLib(corsOptions);
//# sourceMappingURL=cors.js.map