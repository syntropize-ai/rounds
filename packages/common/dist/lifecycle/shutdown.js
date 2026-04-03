// GracefulShutdown - ordered shutdown hook registry
//
// Shutdown order (lower priority number = runs first):
//   10 - stop accepting new requests (HTTP server.close)
//   20 - drain in-flight HTTP requests (with timeout)
//   30 - stop proactive workers / pipeline
//   40 - drain worker queues (BullMQ/InMemory)
//   50 - close DB connection pools
//   60 - close Redis connections / Event Bus
import { createLogger } from '../logging/index.js';
const log = createLogger('graceful-shutdown');
export class GracefulShutdown {
    hooks = [];
    shutdownStarted = false;
    /**
     * Register a shutdown hook.
     * Hooks run in ascending priority order, each with an individual timeout.
     */
    register(hook) {
        this.hooks.push({
            priority: hook.priority ?? 50,
            timeoutMs: hook.timeoutMs ?? 30_000,
            name: hook.name,
            handler: hook.handler,
        });
        // Keep sorted by priority
        this.hooks.sort((a, b) => a.priority - b.priority);
    }
    /**
     * Execute all registered hooks in priority order.
     * Errors from individual hooks are logged but do not stop the sequence.
     */
    async shutdown() {
        if (this.shutdownStarted) {
            log.warn('shutdown already in progress - ignoring duplicate signal');
            return;
        }
        this.shutdownStarted = true;
        log.info('graceful shutdown started (%d hooks)', this.hooks.length);
        for (const hook of this.hooks) {
            log.info('running shutdown hook %s (priority %d)', hook.name, hook.priority);
            try {
                await Promise.race([
                    hook.handler(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${hook.timeoutMs}ms`)), hook.timeoutMs)),
                ]);
                log.info('hook completed: %s', hook.name);
            }
            catch (err) {
                log.error({ err }, 'hook failed: %s', hook.name);
            }
        }
        log.info('graceful shutdown complete');
    }
    /**
     * Attach SIGTERM + SIGINT handlers that call shutdown() then exit.
     * Safe to call multiple times - signals are only attached once.
     */
    listen(exitCode = 0) {
        const handler = () => {
            void this.shutdown().then(() => process.exit(exitCode));
        };
        process.once('SIGTERM', handler);
        process.once('SIGINT', handler);
    }
    get started() {
        return this.shutdownStarted;
    }
}
// Well-known priorities
export const ShutdownPriority = {
    STOP_HTTP_SERVER: 10,
    DRAIN_HTTP: 20,
    STOP_WORKERS: 30,
    DRAIN_QUEUE: 40,
    CLOSE_DB: 50,
    CLOSE_REDIS: 60,
};
//# sourceMappingURL=shutdown.js.map