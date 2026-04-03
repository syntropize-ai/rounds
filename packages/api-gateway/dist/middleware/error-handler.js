import { createLogger } from '@agentic-obs/common';
const log = createLogger('error-handler');
export function errorHandler(err, _req, res, 
// eslint-disable-next-line @typescript-eslint/no-unused-vars
_next) {
    const statusCode = err.statusCode ?? 500;
    // Only expose the original message when:
    // - it is a 4xx (client) error, AND
    // - the error has been explicitly marked as client-safe
    // Server errors (5xx) always return a generic message to avoid leaking internals.
    const safeMessage = statusCode >= 500
        ? 'Internal server error'
        : err.isClientSafe === true
            ? err.message
            : 'Request could not be processed';
    const error = {
        code: err.code ?? (statusCode >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST'),
        message: safeMessage,
    };
    // Never include stack, err.message (unless safe), or implementation details
    if (statusCode >= 500) {
        // Log full error server-side only
        log.error({ statusCode, message: err.message, stack: err.stack }, 'unhandled server error');
    }
    res.status(statusCode).json(error);
}
export function notFoundHandler(req, res) {
    const error = {
        code: 'NOT_FOUND',
        message: `Route ${req.method} ${req.path} not found`,
    };
    res.status(404).json(error);
}
//# sourceMappingURL=error-handler.js.map