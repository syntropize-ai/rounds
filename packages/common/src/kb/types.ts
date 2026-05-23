/**
 * Knowledge-base entry shape. This file mirrors B1's `IKnowledgeRepository`
 * spec so consumers (handlers, route, loader) can compile against a stable
 * surface today. When B1 lands the real data-layer interface, the types here
 * should be re-exported from data-layer (or removed in favor of B1's).
 *
 * The shape itself is the contract; conflicts will be a 5-line resolution
 * (re-export + delete this file).
 */

export type KnowledgeSource = 'bundled' | 'saved' | 'distilled';
export type KnowledgeKind = 'pattern' | 'template' | 'metric_doc' | 'system_fact';

export interface KnowledgeEntry {
  id: string;
  orgId: string;
  source: KnowledgeSource;
  sourceRef: string | null;
  kind: KnowledgeKind;
  title: string;
  intentTags: string[];
  content: unknown;
  useCount: number;
  approvedCount: number;
  rejectedCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Input shape for `insert`. Counts + timestamps are repo-managed. */
export type KnowledgeInsertInput = Omit<
  KnowledgeEntry,
  'createdAt' | 'updatedAt' | 'useCount' | 'approvedCount' | 'rejectedCount'
>;

export interface KnowledgeListOptions {
  kind?: KnowledgeKind;
  source?: KnowledgeSource;
  limit?: number;
}

/** Patch shape for `update`. Only user-editable fields; counts/timestamps/source are repo-managed. */
export type KnowledgePatch = Partial<
  Pick<KnowledgeEntry, 'title' | 'kind' | 'intentTags' | 'content' | 'sourceRef'>
>;

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

// ---------------------------------------------------------------------------
// Content shapes (PatternContent / TemplateContent) — typed so handlers can
// reason about template panels / pattern rowGroups without `any` everywhere.
// ---------------------------------------------------------------------------

export interface PatternPanelSketch {
  kind: 'time_series' | 'stat' | 'gauge' | 'heatmap' | string;
  queryShape: string;
  vizHint?: string;
}

export interface PatternRowGroup {
  title: string;
  panels: PatternPanelSketch[];
}

export interface PatternContent {
  applicableWhen: string;
  structure: { rowGroups: PatternRowGroup[] };
}

export interface TemplateVariable {
  key: string;
  label: string;
  defaultValue: string;
}

export interface TemplateQuery {
  refId: string;
  expr: string;
  legendFormat?: string;
  instant?: boolean;
  datasourceId: string;
}

export interface TemplatePanel {
  id: string;
  title: string;
  description: string;
  visualization: string;
  queries: TemplateQuery[];
  row: number;
  col: number;
  width: number;
  height: number;
  unit?: string;
}

export interface TemplateContent {
  panels: TemplatePanel[];
  variables: TemplateVariable[];
  notes: string;
}
