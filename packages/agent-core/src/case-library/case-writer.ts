// CaseWriter - automatically precipitates resolved investigations into the Case Library.
//
// Flow:
// 1. feedback.adopted must be true - otherwise returns null immediately.
// 2. LLM generalises symptoms / rootCause / resolution from the investigation data.
// 3. Dedup: if retriever.search() returns a hit with score > 0.8 -> skip (return null).
// 4. On pass, add the record via caseStore and return it.

import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { CaseRecord, CaseRetriever, ICaseStore } from './types.js';
import type { InvestigationOutput } from '../investigation/types.js';
import type { StructuredConclusion } from '../explanation/types.js';

export interface InvestigationFeedback {
  adopted: boolean;
  comment?: string;
  rootCauseVerdict?: 'correct' | 'wrong' | 'partially_correct';
}

export interface CaseWriterConfig {
  llm: LLMGateway;
  caseStore: ICaseStore;
  retriever: CaseRetriever;
  model?: string;
  temperature?: number;
  dedupThreshold?: number;
}

interface LLMCaseExtraction {
  title?: unknown;
  symptoms?: unknown;
  rootCause?: unknown;
  resolution?: unknown;
  services?: unknown;
  tags?: unknown;
}

export class CaseWriter {
  private readonly llm: LLMGateway;
  private readonly caseStore: ICaseStore;
  private readonly retriever: CaseRetriever;
  private readonly model: string;
  private readonly temperature: number;
  private readonly dedupThreshold: number;

  constructor(config: CaseWriterConfig) {
    this.llm = config.llm;
    this.caseStore = config.caseStore;
    this.retriever = config.retriever;
    this.model = config.model ?? 'claude-sonnet-4-6';
    this.temperature = config.temperature ?? 0.1;
    this.dedupThreshold = config.dedupThreshold ?? 0.8;
  }

  async extractCase(
    investigation: InvestigationOutput,
    conclusion: StructuredConclusion,
    feedback: InvestigationFeedback,
  ): Promise<CaseRecord | null> {
    if (!feedback.adopted) {
      return null;
    }

    const extracted = await this.extractViaLLM(investigation, conclusion);
    if (!extracted) {
      return null;
    }

    const candidates = this.retriever.search({
      symptoms: extracted.symptoms,
      services: extracted.services,
      tags: extracted.tags,
      topK: 1,
    });

    if (candidates.length > 0 && candidates[0]!.score > this.dedupThreshold) {
      return null;
    }

    return this.caseStore.add({
      title: extracted.title,
      symptoms: extracted.symptoms,
      rootCause: extracted.rootCause,
      resolution: extracted.resolution,
      services: extracted.services,
      tags: extracted.tags,
      source: 'auto',
    });
  }

  private async extractViaLLM(
    investigation: InvestigationOutput,
    conclusion: StructuredConclusion,
  ): Promise<{
    title: string;
    symptoms: string[];
    rootCause: string;
    resolution: string;
    services: string[];
    tags: string[];
  } | null> {
    let raw: string;
    try {
      const response = await this.llm.complete(
        [
          {
            role: 'system',
            content:
              'You are an SRE knowledge-base engineer. ' +
              'Extract a reusable, generalised case record from the investigation data. ' +
              'Avoid referencing specific version numbers, timestamps, or one-off values - ' +
              'focus on the pattern that will help future investigations. ' +
              'Respond with valid JSON only.',
          },
          {
            role: 'user',
            content: this.buildExtractionPrompt(investigation, conclusion),
          },
        ],
        {
          model: this.model,
          temperature: this.temperature,
          maxTokens: 1024,
          responseFormat: 'json',
        },
      );

      raw = response.content;
    } catch {
      return null;
    }

    return this.parseExtraction(raw);
  }

  private buildExtractionPrompt(
    investigation: InvestigationOutput,
    conclusion: StructuredConclusion,
  ): string {
    const topHypothesis = conclusion.hypotheses[0];
    const topFindings = investigation.findings
      .filter((f) => f.isAnomaly)
      .slice(0, 5)
      .map((f) => f.summary);

    return JSON.stringify({
      instruction:
        'Extract a generalised, reusable case record from the investigation below. ' +
        'Generalise symptoms and resolution steps so they apply beyond this specific incident.',
      investigation: {
        entity: investigation.plan.entity,
        objective: investigation.plan.objective,
        anomalousFindings: topFindings,
        stopReason: investigation.stopReason,
      },
      conclusion: {
        summary: conclusion.summary,
        topHypothesis: topHypothesis
          ? {
              description: topHypothesis.hypothesis.description,
              confidence: topHypothesis.hypothesis.confidence,
            }
          : null,
        impact: {
          severity: conclusion.impact.severity,
          affectedServices: conclusion.impact.affectedServices,
        },
        recommendedActions: conclusion.recommendedActions.slice(0, 3).map((r) => ({
          type: r.action.type,
          description: r.action.description,
          rationale: r.rationale,
        })),
      },
      responseSchema: {
        title: 'string - concise case title (no version numbers or dates)',
        symptoms: ['array of short symptom strings (e.g. "p95 latency spike")'],
        rootCause: 'string - generalised root cause pattern',
        resolution: 'string - generalised resolution steps',
        services: 'array of service names from the investigation (exact identifiers)',
        tags: 'array of keyword tags for retrieval (e.g. "latency", "deploy", "database")',
      },
    });
  }

  private parseExtraction(raw: string): {
    title: string;
    symptoms: string[];
    rootCause: string;
    resolution: string;
    services: string[];
    tags: string[];
  } | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFences(raw));
    } catch {
      return null;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const obj = parsed as LLMCaseExtraction;
    const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : null;
    const rootCause =
      typeof obj.rootCause === 'string' && obj.rootCause.trim() ? obj.rootCause.trim() : null;
    const resolution =
      typeof obj.resolution === 'string' && obj.resolution.trim() ? obj.resolution.trim() : null;

    if (!title || !rootCause || !resolution) {
      return null;
    }

    return {
      title,
      symptoms: toStringArray(obj.symptoms),
      rootCause,
      resolution,
      services: toStringArray(obj.services),
      tags: toStringArray(obj.tags),
    };
  }
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return match ? match[1]!.trim() : trimmed;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === 'string').map((v) => (v as string).trim());
}
