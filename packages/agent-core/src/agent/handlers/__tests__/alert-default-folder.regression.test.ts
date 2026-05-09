/**
 * Regression coverage — Task 16, scenario 2 (agent-core slice).
 *
 * Protects the AI alert-creation contract: when no folderUid is supplied,
 * the handler must use (and lazily CREATE) the default `alerts` folder
 * scoped to the caller's org. The route-level equivalent for the manual UI
 * is tested in packages/api-gateway/src/routes/alert-rules.test.ts —
 * this test covers the agent-core handler path which has its own
 * `resolveAlertRuleFolderUid` implementation.
 *
 * Existing alert.test.ts only stubs `findByUid` to return an existing
 * folder — this test specifically protects the create-on-miss branch.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleAlertRuleWrite } from '../alert.js';
import { makeFakeActionContext } from '../_test-helpers.js';
import { makeTestIdentity } from '../../test-helpers.js';

describe('regression: alert handler default Alerts folder (agent-core handler path)', () => {
  it('creates the "alerts" folder when it does not exist and uses it for the rule', async () => {
    const create = vi.fn(async () => ({ uid: 'alerts' }));
    const findByUid = vi.fn(async () => null);
    const folderRepository = { create, findByUid } as never;

    const created = {
      id: 'rule-1',
      name: 'CPUHigh',
      severity: 'high',
      evaluationIntervalSec: 60,
      condition: { query: 'up', operator: '>', threshold: 0.5, forDurationSec: 0 },
    };
    const alertRuleStore = {
      create: vi.fn(async () => created),
      findById: vi.fn(),
      findByWorkspace: vi.fn(async () => []),
      update: vi.fn(),
      delete: vi.fn(),
    } as never;
    const alertRuleAgent = {
      generate: vi.fn(async () => ({
        rule: {
          name: 'CPUHigh',
          description: '',
          condition: { query: 'up', operator: '>', threshold: 0.5, forDurationSec: 0 },
          evaluationIntervalSec: 60,
          severity: 'high',
          labels: {},
        },
      })),
    } as never;

    const ctx = makeFakeActionContext({
      identity: makeTestIdentity({ orgId: 'org-7', userId: 'u-1' }),
      alertRuleStore,
      alertRuleAgent,
      folderRepository,
    });

    const observation = await handleAlertRuleWrite(ctx, {
      op: 'create',
      prompt: 'alert when up > 0.5',
    });

    expect(observation).toContain('Created alert rule "CPUHigh"');
    // Resolution went looking in the caller's org first.
    expect(findByUid).toHaveBeenCalledWith('org-7', 'alerts');
    // Then created the folder under that org with the canonical title.
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: 'alerts',
        orgId: 'org-7',
        title: 'Alerts',
        createdBy: 'u-1',
      }),
    );
    // The alert row was scoped to the resolved folder.
    expect((alertRuleStore as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledWith(
      expect.objectContaining({ folderUid: 'alerts', workspaceId: 'org-7' }),
    );
  });

  it('uses an explicitly supplied folderUid without touching folderRepository', async () => {
    const create = vi.fn();
    const findByUid = vi.fn();
    const folderRepository = { create, findByUid } as never;

    const alertRuleStore = {
      create: vi.fn(async () => ({
        id: 'rule-2',
        name: 'X',
        severity: 'low',
        evaluationIntervalSec: 60,
        condition: { query: 'up', operator: '>', threshold: 0, forDurationSec: 0 },
      })),
      findById: vi.fn(),
      findByWorkspace: vi.fn(async () => []),
      update: vi.fn(),
      delete: vi.fn(),
    } as never;
    const alertRuleAgent = {
      generate: vi.fn(async () => ({
        rule: {
          name: 'X',
          description: '',
          condition: { query: 'up', operator: '>', threshold: 0, forDurationSec: 0 },
          evaluationIntervalSec: 60,
          severity: 'low',
          labels: {},
        },
      })),
    } as never;
    const ctx = makeFakeActionContext({
      alertRuleStore,
      alertRuleAgent,
      folderRepository,
    });

    await handleAlertRuleWrite(ctx, {
      op: 'create',
      prompt: 'alert',
      folderUid: 'team-payments',
    });
    expect(findByUid).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect((alertRuleStore as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledWith(
      expect.objectContaining({ folderUid: 'team-payments' }),
    );
  });
});
