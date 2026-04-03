import type { IWorkerQueue } from '@agentic-obs/common';
import type { ScheduleConfig, ScheduleRecord, ScheduledJobData, ScheduledRunOutcome } from './types.js';
export interface ILLMClient {
    complete(prompt: string): Promise<string>;
}
export interface IScheduledOrchestrator {
    startInvestigation(params: {
        question: string;
        sessionId: string;
        userId: string;
        tenantId: string;
        entity: string;
    }): Promise<{
        investigationId: string;
    }>;
}
export interface IScheduledFeed {
    add(type: string, title: string, summary: string, severity: 'low' | 'medium' | 'high' | 'critical', investigationId?: string, tenantId?: string): void;
}
export interface IMetricsCollector {
    /** Returns a human-readable snapshot of current metrics for serviceId */
    snapshot(serviceId: string): Promise<string>;
}
export declare class NoopMetricsCollector implements IMetricsCollector {
    snapshot(serviceId: string): Promise<string>;
}
export declare const SCHEDULED_INVESTIGATION_QUEUE = "scheduled-investigation";
export interface ScheduledInvestigationDeps {
    llm: ILLMClient;
    orchestrator: IScheduledOrchestrator;
    queue: IWorkerQueue;
    feed: IScheduledFeed;
    metricsCollector?: IMetricsCollector;
}
export declare class ScheduledInvestigation {
    private readonly schedules;
    private readonly timers;
    private unregisterWorker?;
    private readonly llm;
    private readonly orchestrator;
    private readonly queue;
    private readonly feed;
    private readonly metricsCollector;
    constructor(deps: ScheduledInvestigationDeps);
    /** Register a schedule and start its cron timer. */
    schedule(config: ScheduleConfig): ScheduleRecord;
    /** Remove a schedule and cancel its timer. */
    unschedule(id: string): boolean;
    /** List all registered schedules. */
    list(tenantId?: string): ScheduleRecord[];
    /** Get a single schedule by ID. */
    get(id: string): ScheduleRecord | undefined;
    /**
     * Start the worker that processes enqueued scheduled-investigation jobs.
     * Call once at application startup.
     */
    startWorker(): void;
    /** Stop the worker and all timers. */
    stop(): Promise<void>;
    /** Called by the worker for each scheduled-investigation job. */
    runJob(data: ScheduledJobData): Promise<ScheduledRunOutcome>;
    private startTimer;
    private buildPrompt;
    private parseDecision;
    private msUntilNext;
    private nextRunTime;
}
//# sourceMappingURL=scheduled-investigation.d.ts.map