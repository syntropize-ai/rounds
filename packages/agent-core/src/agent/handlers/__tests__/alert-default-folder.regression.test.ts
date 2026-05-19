/**
 * Regression coverage — Grafana folder parity (2026-05-18).
 *
 * Protects the AI alert-creation contract: alerts no longer auto-create a
 * synthetic "Alerts" system folder. Instead:
 *   - explicit `folderUid` arg ⇒ used verbatim
 *   - active dashboard with a folder ⇒ inherit the dashboard's folder
 *   - otherwise ⇒ folderUid omitted from the create payload (root / null)
 *
 * The route-level equivalent for the manual UI is tested in
 * packages/api-gateway/src/routes/alert-rules.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleAlertRuleWrite } from '../alert.js';
import { makeFakeActionContext } from '../_test-helpers.js';
import { makeTestIdentity } from '../../test-helpers.js';

const createSpec = {
  name: 'CPUHigh',
  description: 'Alert when up is above 0.5.',
  condition: { query: 'up', operator: '>', threshold: 0.5, forDurationSec: 0 },
  evaluationIntervalSec: 60,
  severity: 'high',
  labels: {},
};

function makeAlertStore(createdSink: Array<Record<string, unknown>>) {
  return {
    create: vi.fn(async (input: Record<string, unknown>) => {
      createdSink.push(input);
      return {
        id: 'rule-1',
        name: 'CPUHigh',
        severity: 'high',
        evaluationIntervalSec: 60,
        condition: { query: 'up', operator: '>', threshold: 0.5, forDurationSec: 0 },
        ...input,
      };
    }),
    findById: vi.fn(),
    findByWorkspace: vi.fn(async () => []),
    update: vi.fn(),
    delete: vi.fn(),
  } as never;
}

describe('regression: alert handler folder parity (agent-core handler path)', () => {
  it('omits folderUid from the create payload when no folder is requested and no dashboard is active', async () => {
    const created: Array<Record<string, unknown>> = [];
    const ctx = makeFakeActionContext({
      identity: makeTestIdentity({ orgId: 'org-7', userId: 'u-1' }),
      alertRuleStore: makeAlertStore(created),
    });

    const observation = await handleAlertRuleWrite(ctx, { op: 'create', spec: createSpec });

    expect(observation).toContain('Created alert rule "CPUHigh"');
    expect(created).toHaveLength(1);
    // Root-level: folderUid was passed but resolves to null. The store
    // persists null as folder_uid (Grafana parity, "General" scope).
    expect(created[0]!.folderUid).toBeNull();
  });

  it('uses an explicitly supplied folderUid', async () => {
    const created: Array<Record<string, unknown>> = [];
    const ctx = makeFakeActionContext({
      alertRuleStore: makeAlertStore(created),
    });

    await handleAlertRuleWrite(ctx, {
      op: 'create',
      spec: { ...createSpec, name: 'X' },
      folderUid: 'team-payments',
    });

    expect(created[0]!.folderUid).toBe('team-payments');
  });

  it('inherits the active dashboard\'s folder when one is set', async () => {
    const created: Array<Record<string, unknown>> = [];
    const findById = vi.fn(async () => ({ id: 'dash-9', folder: 'team-infra' }));
    const ctx = makeFakeActionContext({
      alertRuleStore: makeAlertStore(created),
    });
    ctx.activeDashboardId = 'dash-9';
    (ctx.store as unknown as { findById: typeof findById }).findById = findById;

    await handleAlertRuleWrite(ctx, { op: 'create', spec: { ...createSpec, name: 'Y' } });

    expect(findById).toHaveBeenCalledWith('dash-9');
    expect(created[0]!.folderUid).toBe('team-infra');
  });

  it('falls back to null when the active dashboard has no folder', async () => {
    const created: Array<Record<string, unknown>> = [];
    const findById = vi.fn(async () => ({ id: 'dash-9' /* no folder */ }));
    const ctx = makeFakeActionContext({
      alertRuleStore: makeAlertStore(created),
    });
    ctx.activeDashboardId = 'dash-9';
    (ctx.store as unknown as { findById: typeof findById }).findById = findById;

    await handleAlertRuleWrite(ctx, { op: 'create', spec: { ...createSpec, name: 'Z' } });

    expect(created[0]!.folderUid).toBeNull();
  });
});
