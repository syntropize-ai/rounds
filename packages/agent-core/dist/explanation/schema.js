import { z } from 'zod';
import { hypothesisSchema } from '../investigation/schema.js';
// — Sub-schemas —
const actionSchema = z.object({
    id: z.string(),
    investigationId: z.string(),
    type: z.enum(['rollback', 'scale', 'restart', 'ticket', 'notify', 'runbook', 'feature_flag']),
    description: z.string(),
    policyTag: z.enum(['suggest', 'approve_required', 'deny']),
    status: z.enum(['proposed', 'approved', 'executing', 'completed', 'failed', 'denied']),
    params: z.record(z.unknown()),
    risk: z.enum(['low', 'medium', 'high']),
    result: z
        .object({
        success: z.boolean(),
        message: z.string(),
        executedAt: z.string().optional(),
    })
        .optional(),
});
const rankedHypothesisSchema = z.object({
    hypothesis: hypothesisSchema,
    rank: z.number().int().min(1),
    evidenceSummary: z.string(),
    confidenceExplanation: z.string(),
});
const impactAssessmentSchema = z.object({
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    affectedServices: z.array(z.string()),
    affectedUsers: z.string(),
    description: z.string(),
});
const recommendedActionSchema = z.object({
    action: actionSchema,
    rationale: z.string(),
    expectedOutcome: z.string(),
    risk: z.string(),
});
// — Top-level output schema —
export const structuredConclusionSchema = z.object({
    summary: z.string(),
    hypotheses: z.array(rankedHypothesisSchema),
    impact: impactAssessmentSchema,
    recommendedActions: z.array(recommendedActionSchema),
    risks: z.array(z.string()),
    uncoveredAreas: z.array(z.string()),
    generatedAt: z.string(),
});
//# sourceMappingURL=schema.js.map
