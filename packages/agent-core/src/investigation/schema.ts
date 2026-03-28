import { z } from 'zod';

// - Shared sub-schemas -----------------------------------------------------

export const hypothesisSchema = z.object({
  id: z.string(),
  investigationId: z.string(),
  description: z.string(),
  confidence: z.number().min(0).max(1),
  confidenceBasis: z.string(),
  evidenceIds: z.array(z.string()),
  counterEvidenceIds: z.array(z.string()),
  status: z.enum(['proposed', 'investigating', 'supported', 'refuted', 'inconclusive']),
});

const stepFindingSchema = z.object({
  stepType: z.string(),
  summary: z.string(),
  value: z.number().optional(),
  baseline: z.number().optional(),
  deviationRatio: z.number().optional(),
  isAnomaly: z.boolean(),
  rawData: z.unknown().optional(),
});

const investigationStepSchema = z.object({
  id: z.string(),
  type: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped']),
  result: z.unknown().optional(),
  cost: z
    .object({
      tokens: z.number(),
      queries: z.number(),
      latencyMs: z.number(),
    })
    .optional(),
});

const stopConditionSchema = z.object({
  type: z.enum(['high_confidence_hypothesis', 'max_cost', 'max_queries', 'time_budget']),
  params: z.record(z.number()),
});

const investigationPlanSchema = z.object({
  entity: z.string(),
  objective: z.string(),
  steps: z.array(investigationStepSchema),
  stopConditions: z.array(stopConditionSchema),
});

// - Top-level output schema ------------------------------------------------

export const investigationOutputSchema = z.object({
  plan: investigationPlanSchema,
  hypotheses: z.array(hypothesisSchema),
  findings: z.array(stepFindingSchema),
  stopReason: z.enum([
    'high_confidence_hypothesis',
    'max_cost',
    'time_budget',
    'all_steps_complete',
  ]),
});

export type InvestigationOutputValidated = z.infer<typeof investigationOutputSchema>;
