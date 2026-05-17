/**
 * Shared fixture helpers for rule unit tests. Keeps each test focused on
 * the rule under test rather than on dashboard scaffolding.
 */

import type { Dashboard, PanelConfig } from '../../../models/dashboard.js';

export function mkPanel(p: Partial<PanelConfig> & { id: string; query?: string }): PanelConfig {
  return {
    title: 'panel',
    description: 'Q: test',
    visualization: 'time_series',
    row: 0,
    col: 0,
    width: 12,
    height: 8,
    ...p,
  };
}

export function mkDashboard(panels: PanelConfig[], overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    id: 'd1',
    type: 'dashboard',
    title: 'test',
    description: '',
    prompt: '',
    userId: 'u',
    status: 'ready',
    panels,
    variables: [],
    refreshIntervalSec: 30,
    datasourceIds: [],
    useExistingMetrics: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}
