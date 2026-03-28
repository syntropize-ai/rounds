import type { AnomalyFinding, AnomalySeverity } from './anomaly-detector.js';

export interface NoiseAssessment {
  confidence: number;
  reasoning: string;
  suggestedSeverity: AnomalySeverity;
}

export interface NoiseEvaluationResult {
  action: 'keep' | 'downgrade' | 'suppress';
  assessment: NoiseAssessment;
}

export interface DismissalRecord {
  findingType: string;
  serviceId: string;
  dismissedAt: string;
}

export interface NoiseReducerConfig {
  llmEvaluator?: (
    finding: AnomalyFinding,
    context: {
      recentDismissals: DismissalRecord[];
      serviceHistory: { totalFindings: number; dismissedCount: number };
    },
  ) => Promise<NoiseAssessment>;
  dismissThreshold?: number;
}

// NoiseReducer
export class NoiseReducer {
  private readonly llmEvaluator?: NoiseReducerConfig['llmEvaluator'];
  private readonly dismissThreshold: number;
  private readonly dismissals: DismissalRecord[] = [];
  private totalEvaluated = 0;

  constructor(config: NoiseReducerConfig = {}) {
    this.llmEvaluator = config.llmEvaluator;
    this.dismissThreshold = config.dismissThreshold ?? 0.3;
  }

  async evaluate(finding: AnomalyFinding): Promise<NoiseEvaluationResult> {
    this.totalEvaluated++;

    if (!this.llmEvaluator) {
      return {
        action: 'keep',
        assessment: {
          confidence: 1,
          reasoning: 'No LLM evaluator configured; keeping all findings by default.',
          suggestedSeverity: finding.severity,
        },
      };
    }

    const context = {
      recentDismissals: [...this.dismissals],
      serviceHistory: this.buildServiceHistory(finding.serviceId),
    };

    const assessment = await this.llmEvaluator(finding, context);
    const confidence = assessment.confidence;
    const suppressThreshold = this.dismissThreshold / 2;

    let action: NoiseEvaluationResult['action'];
    if (confidence < suppressThreshold) {
      action = 'suppress';
    } else if (confidence < this.dismissThreshold) {
      action = 'downgrade';
    } else {
      action = 'keep';
    }

    return { action, assessment };
  }

  recordDismissal(findingType: string, serviceId: string): void {
    this.dismissals.push({
      findingType,
      serviceId,
      dismissedAt: new Date().toISOString(),
    });
  }

  getNoiseRate(): { total: number; dismissed: number; rate: number } {
    const total = this.totalEvaluated;
    const dismissed = this.dismissals.length;
    const rate = total === 0 ? 0 : dismissed / total;
    return { total, dismissed, rate };
  }

  private buildServiceHistory(serviceId: string): {
    totalFindings: number;
    dismissedCount: number;
  } {
    const serviceDismissals = this.dismissals.filter((d) => d.serviceId === serviceId);
    return {
      totalFindings: this.totalEvaluated,
      dismissedCount: serviceDismissals.length,
    };
  }
}
