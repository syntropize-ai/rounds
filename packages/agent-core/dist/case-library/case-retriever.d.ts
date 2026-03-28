import type { CaseQuery, CaseRetriever, ScoredCase } from './types.js';
import type { ICaseStore } from './types.js';

export declare class KeywordCaseRetriever implements CaseRetriever {
  private readonly store;

  constructor(store: ICaseStore);

  search(query: CaseQuery): ScoredCase[];

  /** Compute Jaccard similarity between two token strings (exposed for testing). */
  static jaccardTokens(a: string, b: string): number;

  /** Compute Jaccard similarity between two string arrays (exposed for testing). */
  static jaccardStringArrays(a: string[], b: string[]): number;
}