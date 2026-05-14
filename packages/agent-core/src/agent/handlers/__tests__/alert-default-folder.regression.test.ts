/**
 * Regression coverage — Task 16, scenario 2 (agent-core slice).
 *
 * Wave 1 / PR-C updated the default: agent-created alerts without an explicit
 * folderUid now land in the caller's personal "My Workspace" folder
 * (`uid = user:<userId>`), not the shared `alerts` folder. Explicit folderUid
 * still wins and bypasses the folder repo entirely.
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

describe('regression: alert handler default Alerts folder (agent-core handler path)', () => {
  it('lazy-creates the caller\'s personal workspace folder when it does not exist and uses it', async () => {
    const create = vi.fn(async () => ({ uid: 'user:u-1' }));
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
    const ctx = makeFakeActionContext({
      identity: makeTestIdentity({ orgId: 'org-7', userId: 'u-1' }),
      alertRuleStore,
      folderRepository,
    });

    const observation = await handleAlertRuleWrite(ctx, {
      op: 'create',
      spec: createSpec,
    });

    expect(observation).toContain('Created alert rule "CPUHigh"');
    // Resolution went looking in the caller's org for the personal folder uid.
    expect(findByUid).toHaveBeenCalledWith('org-7', 'user:u-1');
    // Then created the personal-kind folder under that org.
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: 'user:u-1',
        orgId: 'org-7',
        kind: 'personal',
        createdBy: 'u-1',
      }),
    );
    // The alert row was scoped to the resolved folder.
    expect((alertRuleStore as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledWith(
      expect.objectContaining({ folderUid: 'user:u-1', workspaceId: 'org-7' }),
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
    const ctx = makeFakeActionContext({
      alertRuleStore,
      folderRepository,
    });

    await handleAlertRuleWrite(ctx, {
      op: 'create',
      spec: {
        ...createSpec,
        name: 'X',
        severity: 'low',
        condition: { query: 'up', operator: '>', threshold: 0, forDurationSec: 0 },
      },
      folderUid: 'team-payments',
    });
    expect(findByUid).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect((alertRuleStore as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledWith(
      expect.objectContaining({ folderUid: 'team-payments' }),
    );
  });
});
