/**
 * Knowledge-base entry shape. Skill-style: title + description + markdown
 * body + tags. The `kind` axis has been removed — every entry is a skill the
 * agent may consult based on its description.
 */

export type KnowledgeSource = 'bundled' | 'saved' | 'distilled';

export interface KnowledgeEntry {
  id: string;
  orgId: string;
  source: KnowledgeSource;
  sourceRef: string | null;
  title: string;
  description: string;
  body: string;
  intentTags: string[];
  useCount: number;
  approvedCount: number;
  rejectedCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type KnowledgeInsertInput = Omit<
  KnowledgeEntry,
  'createdAt' | 'updatedAt' | 'useCount' | 'approvedCount' | 'rejectedCount'
>;

export type KnowledgePatch = Partial<
  Pick<KnowledgeEntry, 'title' | 'description' | 'body' | 'intentTags' | 'sourceRef'>
>;

export interface KnowledgeListOptions {
  source?: KnowledgeSource;
  limit?: number;
}

export interface IKnowledgeRepository {
  insert(input: KnowledgeInsertInput): Promise<KnowledgeEntry>;
  getById(orgId: string, id: string): Promise<KnowledgeEntry | null>;
  list(orgId: string, opts?: KnowledgeListOptions): Promise<KnowledgeEntry[]>;
  update(orgId: string, id: string, patch: KnowledgePatch): Promise<KnowledgeEntry | null>;
  bumpUseCount(orgId: string, id: string): Promise<void>;
  recordFeedback(orgId: string, id: string, approved: boolean): Promise<void>;
  delete(orgId: string, id: string): Promise<void>;
  listForSearch(orgId: string, opts?: KnowledgeListOptions): Promise<KnowledgeEntry[]>;
}
