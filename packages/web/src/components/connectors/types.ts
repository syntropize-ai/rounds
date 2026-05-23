/**
 * Local UI-side row shape for connectors. Mirrors the JSON returned by
 * GET /connectors — kept here so multiple components in this folder don't
 * each redefine the same anonymous interface.
 */
export interface ConnectorRow {
  id: string;
  type: string;
  name: string;
  category?: string[];
  capabilities?: string[];
  status: 'draft' | 'active' | 'failed' | 'disabled' | string;
  defaultFor?: string | null;
  lastVerifiedAt?: string | null;
  lastVerifyError?: string | null;
  config?: Record<string, unknown>;
  isDefault?: boolean;
}
