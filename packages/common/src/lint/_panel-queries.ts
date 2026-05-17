/**
 * Per-panel query extraction helper, shared across rules.
 *
 * Panels have two query-carrying fields:
 *   - `queries: PanelQuery[]` (v2, current).
 *   - `query?: string`        (v1 legacy, still tolerated for back-compat).
 *
 * Rules iterate panels and call `panelQueryExprs(panel)` to get a flat list
 * of every PromQL string the panel evaluates. Returning [] is normal (e.g.
 * a text panel) — rules must treat that as "no signal" and skip the panel.
 */

import type { PanelConfig } from '../models/dashboard.js';

export function panelQueryExprs(panel: PanelConfig): string[] {
  const out: string[] = [];
  if (Array.isArray(panel.queries)) {
    for (const q of panel.queries) {
      if (typeof q.expr === 'string' && q.expr.trim() !== '') out.push(q.expr);
    }
  }
  if (typeof panel.query === 'string' && panel.query.trim() !== '') {
    out.push(panel.query);
  }
  return out;
}
