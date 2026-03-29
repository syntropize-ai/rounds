/**
 * Prometheus metrics registry for the Agentic Observability Platform.
 *
 * All custom metrics are defined here as module-level singletons so they can be
 * imported and incremented from any module (investigation routes, LLM gateway
 * wrappers, adapter calls, proactive pipeline, etc.).
 */
import { Registry, Counter, Histogram, Gauge } from 'prom-client';
export declare const registry: Registry<"text/plain; version=0.0.4; charset=utf-8">;
export declare const investigationsTotal: Counter<"status">;
export declare const investigationDuration: Histogram<string>;
export declare const llmCallsTotal: Counter<"status" | "provider" | "model">;
export declare const llmLatency: Histogram<"provider" | "model">;
export declare const llmTokensTotal: Counter<"type" | "provider">;
export declare const adapterCallsTotal: Counter<"status" | "adapter">;
export declare const proactiveFindingsTotal: Counter<"type">;
export declare const incidentsTotal: Counter<"severity">;
export declare const approvalsPending: Gauge<string>;
export declare const queueDepth: Gauge<"queue">;
//# sourceMappingURL=metrics.d.ts.map
