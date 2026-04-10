import { z } from 'zod';
export declare const structuredConclusionSchema: z.ZodObject<{
    summary: z.ZodString;
    hypotheses: z.ZodArray<z.ZodObject<{
        hypothesis: z.ZodObject<{
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
        rank: z.ZodNumber;
        evidenceSummary: z.ZodString;
        confidenceExplanation: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        hypothesis: {
            id: string;
            status: "proposed" | "investigating" | "supported" | "refuted" | "inconclusive";
            investigationId: string;
            description: string;
            confidence: number;
            confidenceBasis: string;
            evidenceIds: string[];
            counterEvidenceIds: string[];
        };
        rank: number;
        evidenceSummary: string;
        confidenceExplanation: string;
    }, {
        hypothesis: {
            id: string;
            status: "proposed" | "investigating" | "supported" | "refuted" | "inconclusive";
            investigationId: string;
            description: string;
            confidence: number;
            confidenceBasis: string;
            evidenceIds: string[];
            counterEvidenceIds: string[];
        };
        rank: number;
        evidenceSummary: string;
        confidenceExplanation: string;
    }>, "many">;
    impact: z.ZodObject<{
        severity: z.ZodEnum<["low", "medium", "high", "critical"]>;
        affectedServices: z.ZodArray<z.ZodString, "many">;
        affectedUsers: z.ZodString;
        description: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        description: string;
        severity: "low" | "medium" | "high" | "critical";
        affectedServices: string[];
        affectedUsers: string;
    }, {
        description: string;
        severity: "low" | "medium" | "high" | "critical";
        affectedServices: string[];
        affectedUsers: string;
    }>;
    recommendedActions: z.ZodArray<z.ZodObject<{
        action: z.ZodObject<{
            id: z.ZodString;
            investigationId: z.ZodString;
            type: z.ZodEnum<["rollback", "scale", "restart", "ticket", "notify", "runbook", "feature_flag"]>;
            description: z.ZodString;
            policyTag: z.ZodEnum<["suggest", "approve_required", "deny"]>;
            status: z.ZodEnum<["proposed", "approved", "executing", "completed", "failed", "denied"]>;
            params: z.ZodRecord<z.ZodString, z.ZodUnknown>;
            risk: z.ZodEnum<["low", "medium", "high"]>;
            result: z.ZodOptional<z.ZodObject<{
                success: z.ZodBoolean;
                message: z.ZodString;
                executedAt: z.ZodOptional<z.ZodString>;
            }, "strip", z.ZodTypeAny, {
                success: boolean;
                message: string;
                executedAt?: string | undefined;
            }, {
                success: boolean;
                message: string;
                executedAt?: string | undefined;
            }>>;
        }, "strip", z.ZodTypeAny, {
            id: string;
            params: Record<string, unknown>;
            status: "failed" | "proposed" | "completed" | "approved" | "executing" | "denied";
            investigationId: string;
            description: string;
            type: "scale" | "feature_flag" | "rollback" | "restart" | "ticket" | "notify" | "runbook";
            policyTag: "suggest" | "approve_required" | "deny";
            risk: "low" | "medium" | "high";
            result?: {
                success: boolean;
                message: string;
                executedAt?: string | undefined;
            } | undefined;
        }, {
            id: string;
            params: Record<string, unknown>;
            status: "failed" | "proposed" | "completed" | "approved" | "executing" | "denied";
            investigationId: string;
            description: string;
            type: "scale" | "feature_flag" | "rollback" | "restart" | "ticket" | "notify" | "runbook";
            policyTag: "suggest" | "approve_required" | "deny";
            risk: "low" | "medium" | "high";
            result?: {
                success: boolean;
                message: string;
                executedAt?: string | undefined;
            } | undefined;
        }>;
        rationale: z.ZodString;
        expectedOutcome: z.ZodString;
        risk: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        risk: string;
        action: {
            id: string;
            params: Record<string, unknown>;
            status: "failed" | "proposed" | "completed" | "approved" | "executing" | "denied";
            investigationId: string;
            description: string;
            type: "scale" | "feature_flag" | "rollback" | "restart" | "ticket" | "notify" | "runbook";
            policyTag: "suggest" | "approve_required" | "deny";
            risk: "low" | "medium" | "high";
            result?: {
                success: boolean;
                message: string;
                executedAt?: string | undefined;
            } | undefined;
        };
        rationale: string;
        expectedOutcome: string;
    }, {
        risk: string;
        action: {
            id: string;
            params: Record<string, unknown>;
            status: "failed" | "proposed" | "completed" | "approved" | "executing" | "denied";
            investigationId: string;
            description: string;
            type: "scale" | "feature_flag" | "rollback" | "restart" | "ticket" | "notify" | "runbook";
            policyTag: "suggest" | "approve_required" | "deny";
            risk: "low" | "medium" | "high";
            result?: {
                success: boolean;
                message: string;
                executedAt?: string | undefined;
            } | undefined;
        };
        rationale: string;
        expectedOutcome: string;
    }>, "many">;
    risks: z.ZodArray<z.ZodString, "many">;
    uncoveredAreas: z.ZodArray<z.ZodString, "many">;
    generatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    summary: string;
    hypotheses: {
        hypothesis: {
            id: string;
            status: "proposed" | "investigating" | "supported" | "refuted" | "inconclusive";
            investigationId: string;
            description: string;
            confidence: number;
            confidenceBasis: string;
            evidenceIds: string[];
            counterEvidenceIds: string[];
        };
        rank: number;
        evidenceSummary: string;
        confidenceExplanation: string;
    }[];
    impact: {
        description: string;
        severity: "low" | "medium" | "high" | "critical";
        affectedServices: string[];
        affectedUsers: string;
    };
    recommendedActions: {
        risk: string;
        action: {
            id: string;
            params: Record<string, unknown>;
            status: "failed" | "proposed" | "completed" | "approved" | "executing" | "denied";
            investigationId: string;
            description: string;
            type: "scale" | "feature_flag" | "rollback" | "restart" | "ticket" | "notify" | "runbook";
            policyTag: "suggest" | "approve_required" | "deny";
            risk: "low" | "medium" | "high";
            result?: {
                success: boolean;
                message: string;
                executedAt?: string | undefined;
            } | undefined;
        };
        rationale: string;
        expectedOutcome: string;
    }[];
    risks: string[];
    uncoveredAreas: string[];
    generatedAt: string;
}, {
    summary: string;
    hypotheses: {
        hypothesis: {
            id: string;
            status: "proposed" | "investigating" | "supported" | "refuted" | "inconclusive";
            investigationId: string;
            description: string;
            confidence: number;
            confidenceBasis: string;
            evidenceIds: string[];
            counterEvidenceIds: string[];
        };
        rank: number;
        evidenceSummary: string;
        confidenceExplanation: string;
    }[];
    impact: {
        description: string;
        severity: "low" | "medium" | "high" | "critical";
        affectedServices: string[];
        affectedUsers: string;
    };
    recommendedActions: {
        risk: string;
        action: {
            id: string;
            params: Record<string, unknown>;
            status: "failed" | "proposed" | "completed" | "approved" | "executing" | "denied";
            investigationId: string;
            description: string;
            type: "scale" | "feature_flag" | "rollback" | "restart" | "ticket" | "notify" | "runbook";
            policyTag: "suggest" | "approve_required" | "deny";
            risk: "low" | "medium" | "high";
            result?: {
                success: boolean;
                message: string;
                executedAt?: string | undefined;
            } | undefined;
        };
        rationale: string;
        expectedOutcome: string;
    }[];
    risks: string[];
    uncoveredAreas: string[];
    generatedAt: string;
}>;
export type StructuredConclusionValidated = z.infer<typeof structuredConclusionSchema>;
//# sourceMappingURL=schema.d.ts.map