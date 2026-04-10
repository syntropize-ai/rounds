import { z } from 'zod';
export declare const hypothesisSchema: z.ZodObject<{
    id: z.ZodString;
    investigationId: z.ZodString;
    description: z.ZodString;
    confidence: z.ZodNumber;
    confidenceBasis: z.ZodString;
    evidenceIds: z.ZodArray<z.ZodString, "many">;
    counterEvidenceIds: z.ZodArray<z.ZodString, "many">;
    status: z.ZodEnum<["proposed", "investigating", "supported", "refuted", "inconclusive"]>;
}, "strip", z.ZodTypeAny, {
    id: string;
    status: "proposed" | "investigating" | "supported" | "refuted" | "inconclusive";
    investigationId: string;
    description: string;
    confidence: number;
    confidenceBasis: string;
    evidenceIds: string[];
    counterEvidenceIds: string[];
}, {
    id: string;
    status: "proposed" | "investigating" | "supported" | "refuted" | "inconclusive";
    investigationId: string;
    description: string;
    confidence: number;
    confidenceBasis: string;
    evidenceIds: string[];
    counterEvidenceIds: string[];
}>;
export declare const investigationOutputSchema: z.ZodObject<{
    plan: z.ZodObject<{
        entity: z.ZodString;
        objective: z.ZodString;
        steps: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            type: z.ZodString;
            description: z.ZodString;
            status: z.ZodEnum<["pending", "running", "completed", "failed", "skipped"]>;
            result: z.ZodOptional<z.ZodUnknown>;
            cost: z.ZodOptional<z.ZodObject<{
                tokens: z.ZodNumber;
                queries: z.ZodNumber;
                latencyMs: z.ZodNumber;
            }, "strip", z.ZodTypeAny, {
                tokens: number;
                queries: number;
                latencyMs: number;
            }, {
                tokens: number;
                queries: number;
                latencyMs: number;
            }>>;
        }, "strip", z.ZodTypeAny, {
            id: string;
            status: "failed" | "pending" | "running" | "completed" | "skipped";
            description: string;
            type: string;
            result?: unknown;
            cost?: {
                tokens: number;
                queries: number;
                latencyMs: number;
            } | undefined;
        }, {
            id: string;
            status: "failed" | "pending" | "running" | "completed" | "skipped";
            description: string;
            type: string;
            result?: unknown;
            cost?: {
                tokens: number;
                queries: number;
                latencyMs: number;
            } | undefined;
        }>, "many">;
        stopConditions: z.ZodArray<z.ZodObject<{
            type: z.ZodEnum<["high_confidence_hypothesis", "max_cost", "max_queries", "time_budget"]>;
            params: z.ZodRecord<z.ZodString, z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            params: Record<string, number>;
            type: "high_confidence_hypothesis" | "max_cost" | "time_budget" | "max_queries";
        }, {
            params: Record<string, number>;
            type: "high_confidence_hypothesis" | "max_cost" | "time_budget" | "max_queries";
        }>, "many">;
    }, "strip", z.ZodTypeAny, {
        entity: string;
        objective: string;
        steps: {
            id: string;
            status: "failed" | "pending" | "running" | "completed" | "skipped";
            description: string;
            type: string;
            result?: unknown;
            cost?: {
                tokens: number;
                queries: number;
                latencyMs: number;
            } | undefined;
        }[];
        stopConditions: {
            params: Record<string, number>;
            type: "high_confidence_hypothesis" | "max_cost" | "time_budget" | "max_queries";
        }[];
    }, {
        entity: string;
        objective: string;
        steps: {
            id: string;
            status: "failed" | "pending" | "running" | "completed" | "skipped";
            description: string;
            type: string;
            result?: unknown;
            cost?: {
                tokens: number;
                queries: number;
                latencyMs: number;
            } | undefined;
        }[];
        stopConditions: {
            params: Record<string, number>;
            type: "high_confidence_hypothesis" | "max_cost" | "time_budget" | "max_queries";
        }[];
    }>;
    hypotheses: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        investigationId: z.ZodString;
        description: z.ZodString;
        confidence: z.ZodNumber;
        confidenceBasis: z.ZodString;
        evidenceIds: z.ZodArray<z.ZodString, "many">;
        counterEvidenceIds: z.ZodArray<z.ZodString, "many">;
        status: z.ZodEnum<["proposed", "investigating", "supported", "refuted", "inconclusive"]>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        status: "proposed" | "investigating" | "supported" | "refuted" | "inconclusive";
        investigationId: string;
        description: string;
        confidence: number;
        confidenceBasis: string;
        evidenceIds: string[];
        counterEvidenceIds: string[];
    }, {
        id: string;
        status: "proposed" | "investigating" | "supported" | "refuted" | "inconclusive";
        investigationId: string;
        description: string;
        confidence: number;
        confidenceBasis: string;
        evidenceIds: string[];
        counterEvidenceIds: string[];
    }>, "many">;
    findings: z.ZodArray<z.ZodObject<{
        stepType: z.ZodString;
        summary: z.ZodString;
        value: z.ZodOptional<z.ZodNumber>;
        baseline: z.ZodOptional<z.ZodNumber>;
        deviationRatio: z.ZodOptional<z.ZodNumber>;
        isAnomaly: z.ZodBoolean;
        rawData: z.ZodOptional<z.ZodUnknown>;
    }, "strip", z.ZodTypeAny, {
        stepType: string;
        isAnomaly: boolean;
        summary: string;
        value?: number | undefined;
        rawData?: unknown;
        baseline?: number | undefined;
        deviationRatio?: number | undefined;
    }, {
        stepType: string;
        isAnomaly: boolean;
        summary: string;
        value?: number | undefined;
        rawData?: unknown;
        baseline?: number | undefined;
        deviationRatio?: number | undefined;
    }>, "many">;
    stopReason: z.ZodEnum<["high_confidence_hypothesis", "max_cost", "time_budget", "all_steps_complete"]>;
}, "strip", z.ZodTypeAny, {
    plan: {
        entity: string;
        objective: string;
        steps: {
            id: string;
            status: "failed" | "pending" | "running" | "completed" | "skipped";
            description: string;
            type: string;
            result?: unknown;
            cost?: {
                tokens: number;
                queries: number;
                latencyMs: number;
            } | undefined;
        }[];
        stopConditions: {
            params: Record<string, number>;
            type: "high_confidence_hypothesis" | "max_cost" | "time_budget" | "max_queries";
        }[];
    };
    hypotheses: {
        id: string;
        status: "proposed" | "investigating" | "supported" | "refuted" | "inconclusive";
        investigationId: string;
        description: string;
        confidence: number;
        confidenceBasis: string;
        evidenceIds: string[];
        counterEvidenceIds: string[];
    }[];
    findings: {
        stepType: string;
        isAnomaly: boolean;
        summary: string;
        value?: number | undefined;
        rawData?: unknown;
        baseline?: number | undefined;
        deviationRatio?: number | undefined;
    }[];
    stopReason: "high_confidence_hypothesis" | "max_cost" | "time_budget" | "all_steps_complete";
}, {
    plan: {
        entity: string;
        objective: string;
        steps: {
            id: string;
            status: "failed" | "pending" | "running" | "completed" | "skipped";
            description: string;
            type: string;
            result?: unknown;
            cost?: {
                tokens: number;
                queries: number;
                latencyMs: number;
            } | undefined;
        }[];
        stopConditions: {
            params: Record<string, number>;
            type: "high_confidence_hypothesis" | "max_cost" | "time_budget" | "max_queries";
        }[];
    };
    hypotheses: {
        id: string;
        status: "proposed" | "investigating" | "supported" | "refuted" | "inconclusive";
        investigationId: string;
        description: string;
        confidence: number;
        confidenceBasis: string;
        evidenceIds: string[];
        counterEvidenceIds: string[];
    }[];
    findings: {
        stepType: string;
        isAnomaly: boolean;
        summary: string;
        value?: number | undefined;
        rawData?: unknown;
        baseline?: number | undefined;
        deviationRatio?: number | undefined;
    }[];
    stopReason: "high_confidence_hypothesis" | "max_cost" | "time_budget" | "all_steps_complete";
}>;
export type InvestigationOutputValidated = z.infer<typeof investigationOutputSchema>;
//# sourceMappingURL=schema.d.ts.map