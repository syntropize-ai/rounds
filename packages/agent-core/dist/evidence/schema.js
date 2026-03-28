import { z } from 'zod';
import { hypothesisSchema } from '../investigation/schema.js';

// -- Sub-schemas --------------------------------------------------------------
const evidenceSchema = z.object({
    id: z.string(),
    hypothesisId: z.string(),
    type: z.enum(['metric', 'log', 'trace', 'event', 'change', 'log_cluster', 'trace_waterfall']),
    query: z.string(),
    queryLanguage: z.string(),
    result: z.unknown(),
    summary: z.string(),
    timestamp: z.string(),
    reproducible: z.boolean(),
});

const evidenceChainSchema = z.object({
    hypothesisId: z.string(),
    supportingEvidence: z.array(evidenceSchema),
    counterEvidence: z.array(evidenceSchema),
    confidenceDelta: z.number().min(-1).max(1),
    isConclusive: z.boolean(),
});

// -- Top-level output schema --------------------------------------------------
export const evidenceOutputSchema = z.object({
    hypotheses: z.array(hypothesisSchema),
    evidence: z.array(evidenceSchema),
    chains: z.array(evidenceChainSchema),
});
//# sourceMappingURL=schema.js.map