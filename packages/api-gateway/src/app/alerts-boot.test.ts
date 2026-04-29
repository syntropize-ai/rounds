/**
 * Tests for the alerts-boot wiring — evaluator startup gate + dispatcher
 * gate matrix.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { IAlertRuleRepository } from '@agentic-obs/data-layer';
import type { SetupConfigService } from '../services/setup-config-service.js';
import { startAlerts } from './alerts-boot.js';

function fakeRepo(): IAlertRuleRepository {
  return {
    create: async () => ({}) as never,
    findById: async () => undefined,
    findAll: async () => ({ list: [], total: 0 }),
    findByWorkspace: async () => [],
    update: async () => undefined,
    delete: async () => false,
    transition: async () => undefined,
    getHistory: async () => [],
    getAllHistory: async () => [],
    createSilence: async () => ({}) as never,
    findSilences: async () => [],
    findAllSilencesIncludingExpired: async () => [],
    updateSilence: async () => undefined,
    deleteSilence: async () => false,
    listContactPoints: async () => [],
    upsertContactPoint: async () => ({}) as never,
    deleteContactPoint: async () => false,
    listMuteTimings: async () => [],
    upsertMuteTiming: async () => ({}) as never,
    deleteMuteTiming: async () => false,
    getNotificationPolicyTree: async () => null,
    setNotificationPolicyTree: async () => undefined,
  } as unknown as IAlertRuleRepository;
}

function fakeSetupConfig(): SetupConfigService {
  return {
    listDatasources: async () => [],
    getLlm: async () => null,
  } as unknown as SetupConfigService;
}

describe('startAlerts', () => {
  const orig = { ...process.env };
  beforeEach(() => {
    process.env = { ...orig };
  });

  it('returns null evaluator when ALERT_EVALUATOR_ENABLED=false', async () => {
    process.env['ALERT_EVALUATOR_ENABLED'] = 'false';
    const handle = await startAlerts({ rules: fakeRepo(), setupConfig: fakeSetupConfig() });
    expect(handle.evaluator).toBeNull();
    expect(handle.dispatcher).toBeNull();
    handle.stop();
  });

  it('starts evaluator but skips dispatcher when SA token unset', async () => {
    delete process.env['AUTO_INVESTIGATION_SA_TOKEN'];
    const handle = await startAlerts({ rules: fakeRepo(), setupConfig: fakeSetupConfig() });
    expect(handle.evaluator).not.toBeNull();
    expect(handle.dispatcher).toBeNull();
    handle.stop();
  });

  it('skips dispatcher when AUTO_INVESTIGATION_ENABLED=false even with token + runner', async () => {
    process.env['AUTO_INVESTIGATION_SA_TOKEN'] = 'openobs_sa_x';
    process.env['AUTO_INVESTIGATION_ENABLED'] = 'false';
    const handle = await startAlerts({
      rules: fakeRepo(),
      setupConfig: fakeSetupConfig(),
      runner: {
        saTokens: { validateAndLookup: async () => null },
        makeOrchestrator: () => ({}) as never,
      },
    });
    expect(handle.evaluator).not.toBeNull();
    expect(handle.dispatcher).toBeNull();
    handle.stop();
  });

  it('starts dispatcher when token + runner + flag are all set', async () => {
    process.env['AUTO_INVESTIGATION_SA_TOKEN'] = 'openobs_sa_x';
    delete process.env['AUTO_INVESTIGATION_ENABLED'];
    const handle = await startAlerts({
      rules: fakeRepo(),
      setupConfig: fakeSetupConfig(),
      runner: {
        saTokens: { validateAndLookup: async () => null },
        makeOrchestrator: () => ({}) as never,
      },
    });
    expect(handle.evaluator).not.toBeNull();
    expect(handle.dispatcher).not.toBeNull();
    handle.stop();
  });
});
