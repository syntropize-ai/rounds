// ScheduledInvestigation - cron-triggered LLM-evaluated investigation
//
// Flow:
// 1. Cron fires -> enqueue('scheduled-investigation', jobData)
// 2. Worker picks up job -> collectMetrics(serviceId)
// 3. LLM evaluates: "Is there anything worth investigating?"
// 4. LLM yes -> create full investigation via orchestrator
// 5. LLM no  -> log "all clear" to feed

import { randomUUID } from 'crypto';
import cronParser from 'cron-parser';
import type { WorkerQueue } from '@agentic-obs/common';
import { LLMUnavailableError } from '@agentic-obs/common';
import type {
  ScheduleConfig,
  ScheduleRecord,
  ScheduledJobData,
  LLMCheckResponse,
  ScheduledRunOutcome,
} from './types.js';

// - LLM interface (minimal - same pattern as other agents) -----------------

export interface ILLMClient {
  complete(prompt: string): Promise<string>;
}

// - Orchestrator interface (minimal) ---------------------------------------

export interface IScheduledOrchestrator {
  startInvestigation(params: {
    question: string;
    sessionId: string;
    userId: string;
    tenantId: string;
    entity: string;
  }): Promise<{ investigationId: string }>;
}

// - Feed interface (minimal) -----------------------------------------------

export interface IScheduledFeed {
  add(
    type: string,
    title: string,
    summary: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    investigationId?: string,
    tenantId?: string,
  ): void;
}

// - Metrics collector interface --------------------------------------------

export interface IMetricsCollector {
  /** Returns a human-readable snapshot of current metrics for serviceId */
  snapshot(serviceId: string): Promise<string>;
}

export class NoopMetricsCollector implements IMetricsCollector {
  async snapshot(serviceId: string): Promise<string> {
    return `Service ${serviceId}: no metrics available (noop collector)`;
  }
}

// - Queue name constant ----------------------------------------------------

export const SCHEDULED_INVESTIGATION_QUEUE = 'scheduled-investigation';

// - ScheduledInvestigation class -------------------------------------------

export interface ScheduledInvestigationDeps {
  llm: ILLMClient;
  orchestrator: IScheduledOrchestrator;
  queue: WorkerQueue;
  feed: IScheduledFeed;
  metricsCollector?: IMetricsCollector;
}

export class ScheduledInvestigation {
  private readonly schedules = new Map<string, ScheduleRecord>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private unregisterWorker?: () => Promise<void>;

  private readonly llm: ILLMClient;
  private readonly orchestrator: IScheduledOrchestrator;
  private readonly queue: WorkerQueue;
  private readonly feed: IScheduledFeed;
  private readonly metricsCollector: IMetricsCollector;

  constructor(deps: ScheduledInvestigationDeps) {
    this.llm = deps.llm;
    this.orchestrator = deps.orchestrator;
    this.queue = deps.queue;
    this.feed = deps.feed;
    this.metricsCollector = deps.metricsCollector ?? new NoopMetricsCollector();
  }

  /** Register a schedule and start its cron timer. */
  schedule(config: ScheduleConfig): ScheduleRecord {
    const record: ScheduleRecord = {
      id: config.id ?? randomUUID(),
      serviceId: config.serviceId,
      cron: config.cron,
      depth: config.depth,
      description: config.description,
      tenantId: config.tenantId ?? 'default',
      enabled: config.enabled ?? true,
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      nextRunAt: this.nextRunTime(config.cron),
    };

    this.schedules.set(record.id, record);
    if (record.enabled) {
      this.startTimer(record);
    }

    return record;
  }

  /** Remove a schedule and cancel its timer. */
  unschedule(id: string): boolean {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    return this.schedules.delete(id);
  }

  /** List all registered schedules. */
  list(tenantId?: string): ScheduleRecord[] {
    const all = Array.from(this.schedules.values());
    return tenantId ? all.filter((s) => s.tenantId === tenantId) : all;
  }

  /** Get a single schedule by ID. */
  get(id: string): ScheduleRecord | undefined {
    return this.schedules.get(id);
  }

  /**
   * Start the worker that processes enqueued scheduled-investigation jobs.
   * Call once at application startup.
   */
  startWorker(): void {
    const unregister = this.queue.process<ScheduledJobData>(
      SCHEDULED_INVESTIGATION_QUEUE,
      async (job) => {
        await this.runJob(job.data);
      },
    );

    this.unregisterWorker = unregister;
  }

  /** Stop the worker and all timers. */
  async stop(): Promise<void> {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    if (this.unregisterWorker) {
      await this.unregisterWorker();
    }
  }

  // - Internal: job execution ----------------------------------------------

  /** Called by the worker for each scheduled-investigation job. */
  async runJob(data: ScheduledJobData): Promise<ScheduledRunOutcome> {
    const metrics = await this.metricsCollector.snapshot(data.serviceId);
    const ranAt = new Date().toISOString();

    let decision: LLMCheckResponse;
    try {
      const prompt = this.buildPrompt(data, metrics);
      const raw = await this.llm.complete(prompt);
      decision = this.parseDecision(raw);
    } catch (err) {
      const reason =
        err instanceof LLMUnavailableError
          ? err.message
          : 'LLM unavailable - will retry on next cron trigger';
      return {
        scheduleId: data.scheduleId,
        serviceId: data.serviceId,
        ranAt,
        decision: 'skipped_llm_unavailable',
        reason,
      };
    }

    // Update schedule record
    const record = this.schedules.get(data.scheduleId);
    if (record) {
      record.lastRunAt = ranAt;
      record.nextRunAt = this.nextRunTime(record.cron);
    }

    if (decision.shouldInvestigate) {
      const question = `Scheduled check for ${data.serviceId} (${data.depth}): ${data.description}\n\nReason to investigate: ${decision.reason}`;
      const { investigationId } = await this.orchestrator.startInvestigation({
        question,
        sessionId: `scheduled-${data.scheduleId}-${Date.now()}`,
        userId: 'scheduler-runner',
        tenantId: data.tenantId,
        entity: data.serviceId,
      });

      this.feed.add(
        'anomaly_detected',
        `Scheduled check triggered investigation for ${data.serviceId}`,
        decision.reason,
        data.depth === 'thorough' ? 'high' : 'medium',
        investigationId,
        data.tenantId,
      );

      return {
        scheduleId: data.scheduleId,
        serviceId: data.serviceId,
        ranAt,
        decision: 'investigate',
        investigationId,
        reason: decision.reason,
      };
    } else {
      this.feed.add(
        'change_impact',
        `Scheduled check: all clear - ${data.serviceId}`,
        decision.reason,
        'low',
        undefined,
        data.tenantId,
      );

      return {
        scheduleId: data.scheduleId,
        serviceId: data.serviceId,
        ranAt,
        decision: 'all_clear',
        reason: decision.reason,
      };
    }
  }

  // - Internal: cron timer -------------------------------------------------

  private startTimer(record: ScheduleRecord): void {
    const intervalMs = this.msUntilNext(record.cron);

    const fire = () => {
      const jobData: ScheduledJobData = {
        scheduleId: record.id,
        serviceId: record.serviceId,
        depth: record.depth,
        description: record.description,
        tenantId: record.tenantId,
      };

      void this.queue.enqueue(SCHEDULED_INVESTIGATION_QUEUE, jobData, {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
      });

      // Reschedule
      if (this.schedules.has(record.id)) {
        this.timers.set(record.id, setTimeout(fire, intervalMs));
      }
    };

    this.timers.set(record.id, setTimeout(fire, intervalMs));
  }

  // - Internal: LLM prompt -------------------------------------------------

  private buildPrompt(data: ScheduledJobData, metrics: string): string {
    return `You are an SRE assistant performing a scheduled health check.

Service: ${data.serviceId}
Description: ${data.description}
Depth: ${data.depth}

Current metrics snapshot:
${metrics}

Based on the above metrics, decide whether there is anything worth investigating for service ${data.serviceId}.

Respond ONLY with a JSON object in this exact format:
{
  "shouldInvestigate": true | false,
  "reason": "one sentence explaining your decision"
}`.trim();
  }

  private parseDecision(raw: string): LLMCheckResponse {
    // Strip markdown code fences if present
    const clean = raw.replace(/^```(?:json)?/gi, '').trim();
    try {
      const parsed = JSON.parse(clean) as LLMCheckResponse;
      if (
        typeof parsed.shouldInvestigate === 'boolean' &&
        typeof parsed.reason === 'string'
      ) {
        return parsed;
      }
    } catch {
      // Fall through to throw
    }

    throw new LLMUnavailableError(
      'LLM response could not be parsed - worker queue will retry',
    );
  }

  // - Internal: cron helpers -----------------------------------------------

  private msUntilNext(cron: string): number {
    try {
      const interval = cronParser.parseExpression(cron, { currentDate: new Date() });
      return interval.next().getTime() - Date.now();
    } catch {
      return 60_000; // fallback: 1 minute
    }
  }

  private nextRunTime(cron: string): string {
    try {
      const interval = cronParser.parseExpression(cron, { currentDate: new Date() });
      return interval.next().toISOString();
    } catch {
      return new Date(Date.now() + 60_000).toISOString();
    }
  }
}
