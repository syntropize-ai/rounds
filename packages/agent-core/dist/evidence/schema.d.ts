import { z } from 'zod';

export declare const evidenceOutputSchema: z.ZodObject<{
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
    evidence: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        hypothesisId: z.ZodString;
        type: z.ZodEnum<["metric", "log", "trace", "event", "change", "log_cluster", "trace_waterfall"]>;
        query: z.ZodString;
        queryLanguage: z.ZodString;
        result: z.ZodUnknown;
        summary: z.ZodString;
        timestamp: z.ZodString;
        reproducible: z.ZodBoolean;
    }, "strip", z.ZodTypeAny, {
        id: string;
        summary: string;
        type: "metric" | "log" | "trace" | "event" | "change" | "log_cluster" | "trace_waterfall";
        hypothesisId: string;
        query: string;
        queryLanguage: string;
        timestamp: string;
        reproducible: boolean;
        result?: unknown;
    }, {
        id: string;
        summary: string;
        type: "metric" | "log" | "trace" | "event" | "change" | "log_cluster" | "trace_waterfall";
        hypothesisId: string;
        query: string;
        queryLanguage: string;
        timestamp: string;
        reproducible: boolean;
        result?: unknown;
    }>, "many">;
    chains: z.ZodArray<z.ZodObject<{
        hypothesisId: z.ZodString;
        supportingEvidence: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            hypothesisId: z.ZodString;
            type: z.ZodEnum<["metric", "log", "trace", "event", "change", "log_cluster", "trace_waterfall"]>;
            query: z.ZodString;
            queryLanguage: z.ZodString;
            result: z.ZodUnknown;
            summary: z.ZodString;
            timestamp: z.ZodString;
            reproducible: z.ZodBoolean;
        }, "strip", z.ZodTypeAny, {
            id: string;
            summary: string;
            type: "metric" | "log" | "trace" | "event" | "change" | "log_cluster" | "trace_waterfall";
            hypothesisId: string;
            query: string;
            queryLanguage: string;
            timestamp: string;
            reproducible: boolean;
            result?: unknown;
        }, {
            id: string;
            summary: string;
            type: "metric" | "log" | "trace" | "event" | "change" | "log_cluster" | "trace_waterfall";
            hypothesisId: string;
            query: string;
            queryLanguage: string;
            timestamp: string;
            reproducible: boolean;
            result?: unknown;
        }>>;
        counterEvidence: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            hypothesisId: z.ZodString;
            type: z.ZodEnum<["metric", "log", "trace", "event", "change", "log_cluster", "trace_waterfall"]>;
            query: z.ZodString;
            queryLanguage: z.ZodString;
            result: z.ZodUnknown;
            summary: z.ZodString;
            timestamp: z.ZodString;
            reproducible: z.ZodBoolean;
        }, "strip", z.ZodTypeAny, {
            id: string;
            summary: string;
            type: "metric" | "log" | "trace" | "event" | "change" | "log_cluster" | "trace_waterfall";
            hypothesisId: string;
            query: string;
            queryLanguage: string;
            timestamp: string;
            reproducible: boolean;
            result?: unknown;
        }, {
            id: string;
            summary: string;
            type: "metric" | "log" | "trace" | "event" | "change" | "log_cluster" | "trace_waterfall";
            hypothesisId: string;
            query: string;
            queryLanguage: string;
            timestamp: string;
            reproducible: boolean;
            result?: unknown;
        }>>;
        confidenceDelta: z.ZodNumber;
        isConclusive: z.ZodBoolean;
    }, "strip", z.ZodTypeAny, {
        hypothesisId: string;
        supportingEvidence: {
            id: string;
            summary: string;
            type: "metric" | "log" | "trace" | "event" | "change" | "log_cluster" | "trace_waterfall";
            hypothesisId: string;
            query: string;
            queryLanguage: string;
            timestamp: string;
            reproducible: boolean;
            result?: unknown;
        }[];
        counterEvidence: {
            id: string;
            summary: string;
            type: "metric" | "log" | "trace" | "event" | "change" | "log_cluster" | "trace_waterfall";
            hypothesisId: string;
            query: string;
            queryLanguage: string;
            timestamp: string;
            reproducible: boolean;
            result?: unknown;
        }[];
        confidenceDelta: number;
        isConclusive: boolean;
    }, {
        hypothesisId: string;
        supportingEvidence: {
            id: string;
            summary: string;
            type: "metric" | "log" | "trace" | "event" | "change" | "log_cluster" | "trace_waterfall";
            hypothesisId: string;
            query: string;
            queryLanguage: string;
            timestamp: string;
            reproducible: boolean;
            result?: unknown;
        }[];
        counterEvidence: {
            id: string;
            summary: string;
            type: "metric" | "log" | "trace" | "event" | "change" | "log_cluster" | "trace_waterfall";
            hypothesisId: string;
            query: string;
            queryLanguage: string;
            timestamp: string;
            reproducible: boolean;
            result?: unknown;
        }[];
        confidenceDelta: number;
        isConclusive: boolean;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
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
    evidence: {
        id: string;
        summary: string;
        type: "metric" | "log" | "trace" | "event" | "change" | "log_cluster" | "trace_waterfall";
        hypothesisId: string;
        query: string;
        queryLanguage: string;
        timestamp: string;
        reproducible: boolean;
        result?: unknown;
    }[];
    chains: {
        hypothesisId: string;
        supportingEvidence: {
            id: string;
            summary: string;
            type: "metric" | "log" | "trace" | "event" | "change" | "log_cluster" | "trace_waterfall";
            hypothesisId: string;
            query: string;
            queryLanguage: string;
            timestamp: string;
            reproducible: boolean;
            result?: unknown;
        }[];
        counterEvidence: {
            id: string;
            summary: string;
            type: "metric" | "log" | "trace" | "event" | "change" | "log_cluster" | "trace_waterfall";
            hypothesisId: string;
            query: string;
            queryLanguage: string;
            timestamp: string;
            reproducible: boolean;
            result?: unknown;
        }[];
        confidenceDelta: number;
        isConclusive: boolean;
    }[];
}, {
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
    evidence: {
        id: string;
        summary: string;
        type: "metric" | "log" | "trace" | "event" | "change" | "log_cluster" | "trace_waterfall";
        hypothesisId: string;
        query: string;
        queryLanguage: string;
        timestamp: string;
        reproducible: boolean;
        result?: unknown;
    }[];
    chains: {
        hypothesisId: string;
        supportingEvidence: {
            id: string;
            summary: string;
            type: "metric" | "log" | "trace" | "event" | "change" | "log_cluster" | "trace_waterfall";
            hypothesisId: string;
            query: string;
            queryLanguage: string;
            timestamp: string;
            reproducible: boolean;
            result?: unknown;
        }[];
        counterEvidence: {
            id: string;
            summary: string;
            type: "metric" | "log" | "trace" | "event" | "change" | "log_cluster" | "trace_waterfall";
            hypothesisId: string;
            query: string;
            queryLanguage: string;
            timestamp: string;
            reproducible: boolean;
            result?: unknown;
        }[];
        confidenceDelta: number;
        isConclusive: boolean;
    }[];
}>;

export type EvidenceOutputValidated = z.infer<typeof evidenceOutputSchema>;
//# sourceMappingURL=schema.d.ts.map