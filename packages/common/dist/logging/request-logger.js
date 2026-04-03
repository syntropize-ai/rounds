import { v4 as uuidv4 } from 'uuid';
import { correlationStore } from './correlation.js';
import { createLogger } from './logger.js';
const httpLogger = createLogger('http');
export function requestLogger(req, res, next) {
    const requestId = uuidv4();
    // Make requestId accessible to route handlers via res.locals
    res.locals['requestId'] = requestId;
    const start = Date.now();
    correlationStore.run({ requestId }, () => {
        // `mixin` on httpLogger will automatically inject requestId from correlationStore
        httpLogger.info({ method: req.method, url: req.url }, 'request received');
        res.on('finish', () => {
            const duration = Date.now() - start;
            const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
            httpLogger[level]({ body: req.method, url: req.url, status: res.statusCode, duration }, 'request completed');
        });
        next();
    });
}
//# sourceMappingURL=request-logger.js.map