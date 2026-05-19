import { describe, it, expect, vi } from 'vitest';
import type { IFolderRepository, GrafanaFolder } from '@agentic-obs/common';
import type { IAlertRuleRepository } from '@agentic-obs/data-layer';
import type { AlertRule } from '@agentic-obs/common';
import { cleanupLegacyAlertsFolder } from './alerts-folder-cleanup.js';

function makeFolderRepo(existing: GrafanaFolder | null): {
  repo: IFolderRepository;
  update: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} {
  const update = vi.fn(async () => existing);
  const del = vi.fn(async () => true);
  const repo = {
    findByUid: vi.fn(async () => existing),
    update,
    create: vi.fn(),
    findById: vi.fn(),
    list: vi.fn(),
    listAncestors: vi.fn(),
    listChildren: vi.fn(),
    delete: del,
  } as unknown as IFolderRepository;
  return { repo, update, del };
}

function makeAlertRepo(rules: AlertRule[] = []): {
  repo: IAlertRuleRepository;
  updateMock: ReturnType<typeof vi.fn>;
} {
  const updateMock = vi.fn(async () => undefined);
  const repo = {
    findAll: vi.fn(async () => ({ list: rules, total: rules.length })),
    update: updateMock,
    create: vi.fn(),
    findById: vi.fn(),
    delete: vi.fn(),
  } as unknown as IAlertRuleRepository;
  return { repo, updateMock };
}

function folder(overrides: Partial<GrafanaFolder> = {}): GrafanaFolder {
  return {
    id: 'f1',
    uid: 'alerts',
    orgId: 'org_main',
    title: 'Alerts',
    description: '',
    parentUid: null,
    created: '2026-04-30T00:00:00.000Z',
    updated: '2026-04-30T00:00:00.000Z',
    createdBy: null,
    updatedBy: null,
    ...overrides,
  };
}

function rule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'r1',
    orgId: 'org_main',
    name: 'X',
    description: '',
    condition: { query: 'up', operator: '>', threshold: 0, forDurationSec: 0 },
    evaluationIntervalSec: 60,
    severity: 'high',
    state: 'normal',
    stateChangedAt: '2026-04-30T00:00:00.000Z',
    fireCount: 0,
    createdBy: 'user',
    createdAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
    folderUid: 'alerts',
    ...overrides,
  } as AlertRule;
}

describe('cleanupLegacyAlertsFolder', () => {
  it('migrates alert rules to root and deletes the folder when it still has auto-created title', async () => {
    const { repo: folders, del } = makeFolderRepo(folder());
    const { repo: alerts, updateMock } = makeAlertRepo([rule()]);
    await cleanupLegacyAlertsFolder(folders, alerts, 'org_main');
    expect(updateMock).toHaveBeenCalledWith('r1', { folderUid: null });
    expect(del).toHaveBeenCalledWith('f1');
  });

  it('deletes an empty legacy folder with no rules', async () => {
    const { repo: folders, del } = makeFolderRepo(folder());
    const { repo: alerts, updateMock } = makeAlertRepo([]);
    await cleanupLegacyAlertsFolder(folders, alerts, 'org_main');
    expect(updateMock).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith('f1');
  });

  it('is a no-op when the folder does not exist', async () => {
    const { repo: folders, del } = makeFolderRepo(null);
    const { repo: alerts, updateMock } = makeAlertRepo([]);
    await cleanupLegacyAlertsFolder(folders, alerts, 'org_main');
    expect(updateMock).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('skips when the user has renamed the folder', async () => {
    const { repo: folders, del } = makeFolderRepo(folder({ title: 'Team Alerts' }));
    const { repo: alerts, updateMock } = makeAlertRepo([rule()]);
    await cleanupLegacyAlertsFolder(folders, alerts, 'org_main');
    expect(updateMock).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('swallows repository errors so boot is never blocked', async () => {
    const folders = {
      findByUid: vi.fn(async () => { throw new Error('db down'); }),
      delete: vi.fn(),
    } as unknown as IFolderRepository;
    const alerts = { findAll: vi.fn(), update: vi.fn() } as unknown as IAlertRuleRepository;
    await expect(cleanupLegacyAlertsFolder(folders, alerts, 'org_main')).resolves.toBeUndefined();
  });
});
