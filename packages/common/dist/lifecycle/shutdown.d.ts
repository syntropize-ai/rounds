export interface ShutdownHook {
    name: string;
    /** Lower numbers run first (default: 50) */
    priority?: number;
    /** Maximum ms to wait for this hook (default: 30000) */
    timeoutMs?: number;
    handler(): Promise<void>;
}
export declare class GracefulShutdown {
    private readonly hooks;
    private shutdownStarted;
    /**
     * Register a shutdown hook.
     * Hooks run in ascending priority order, each with an individual timeout.
     */
    register(hook: ShutdownHook): void;
    /**
     * Execute all registered hooks in priority order.
     * Errors from individual hooks are logged but do not stop the sequence.
     */
    shutdown(): Promise<void>;
    /**
     * Attach SIGTERM + SIGINT handlers that call shutdown() then exit.
     * Safe to call multiple times - signals are only attached once.
     */
    listen(exitCode?: number): void;
    get started(): boolean;
}
export declare const ShutdownPriority: {
    readonly STOP_HTTP_SERVER: 10;
    readonly DRAIN_HTTP: 20;
    readonly STOP_WORKERS: 30;
    readonly DRAIN_QUEUE: 40;
    readonly CLOSE_DB: 50;
    readonly CLOSE_REDIS: 60;
};
//# sourceMappingURL=shutdown.d.ts.map