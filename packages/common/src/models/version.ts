export type AssetType = 'dashboard' | 'alert_rule' | 'investigation_report';
export type EditSource = 'human' | 'llm' | 'system';

export interface AssetVersion {
  id: string;
  assetType: AssetType;
  assetId: string;
  version: number; // incrementing version number
  snapshot: unknown; // full asset state at this version
  diff?: unknown; // changes from previous version (optional)
  editedBy: string; // userId or 'llm' or 'system'
  editSource: EditSource;
  message?: string; // optional commit-style message
  createdAt: string;
}

export type PublishStatus = 'draft' | 'published' | 'archived';
