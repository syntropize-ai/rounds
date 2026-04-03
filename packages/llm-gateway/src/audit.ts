// Audit logger — in-memory store for LLM call records

export interface AuditEntry {
  id: string;
  timestamp: Date;
  provider: string;
  model: string;
  promptHash: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  success: boolean;
  error?: string;
}

export class AuditLogger {
  private entries: AuditEntry[] = [];

  record(entry: AuditEntry): void {
    this.entries.push(entry);
  }

  getEntries(): readonly AuditEntry[] {
    return this.entries;
  }

  getEntriesByModel(model: string): AuditEntry[] {
    return this.entries.filter((e) => e.model === model);
  }

  getEntriesByProvider(provider: string): AuditEntry[] {
    return this.entries.filter((e) => e.provider === provider);
  }

  getTotalTokens(): number {
    return this.entries.reduce((sum, e) => sum + e.totalTokens, 0);
  }

  clear(): void {
    this.entries = [];
  }
}
