/**
 * Tests for the alerts-boot wiring — evaluator startup gate + consumer
 * gate matrix.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { IAlertRuleRepository } from '@agentic-obs/data-layer';
import { InMemoryEventBus } from '@agentic-obs/common/events';
import type { SetupConfigService } from '../services/setup-config-service.js';
import type { ConsumerInvestigationStore } from '../services/auto-investigation-consumer.js';
import { startAlerts } from './alerts-boot.js';

function fakeInvestigations(): ConsumerInvestigationStore {
  return {
    findById: async () => null,
    findByWorkspace: async () => [],
    updateStatus: async () => null,
  };
}

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
    listConnectors: async () => [],
    getLlm: async () => null,
  } as unknown as SetupConfigService;
}

describe('startAlerts', () => {
  const orig = { ...process.env };
  beforeEach(() => {
    process.env = { ...orig };
    delete process.env['AUTO_INVESTIGATION_SA_TOKEN'];
  });

  it('returns null evaluator when ALERT_EVALUATOR_ENABLED=false', async () => {
    process.env['ALERT_EVALUATOR_ENABLED'] = 'false';
    const handle = await startAlerts({ rules: fakeRepo(), setupConfig: fakeSetupConfig() });
    expect(handle.evaluator).toBeNull();
    expect(handle.consumer).toBeNull();
    handle.stop();
  });

  it('starts evaluator but skips consumer when no resolver/authRepos provided', async () => {
    const handle = await startAlerts({
      rules: fakeRepo(),
      setupConfig: fakeSetupConfig(),
      runner: {
        saTokens: { validateAndLookup: async () => null },
        makeOrchestrator: () => ({}) as never,
      },
      eventBus: new InMemoryEventBus(),
      investigations: fakeInvestigations(),
    });
    expect(handle.evaluator).not.toBeNull();
    expect(handle.consumer).toBeNull();
    handle.stop();
  });

  it('skips consumer when AUTO_INVESTIGATION_ENABLED=false even with resolver + runner', async () => {
    process.env['AUTO_INVESTIGATION_ENABLED'] = 'false';
    const handle = await startAlerts({
      rules: fakeRepo(),
      setupConfig: fakeSetupConfig(),
      resolveSaIdentity: async () => null,
      runner: {
        saTokens: { validateAndLookup: async () => null },
        makeOrchestrator: () => ({}) as never,
      },
      eventBus: new InMemoryEventBus(),
      investigations: fakeInvestigations(),
    });
    expect(handle.evaluator).not.toBeNull();
    expect(handle.consumer).toBeNull();
    handle.stop();
  });

  it('skips consumer when eventBus is not wired', async () => {
    delete process.env['AUTO_INVESTIGATION_ENABLED'];
    const handle = await startAlerts({
      rules: fakeRepo(),
      setupConfig: fakeSetupConfig(),
      resolveSaIdentity: async () => null,
      runner: {
        saTokens: { validateAndLookup: async () => null },
        makeOrchestrator: () => ({}) as never,
      },
      investigations: fakeInvestigations(),
    });
    expect(handle.evaluator).not.toBeNull();
    expect(handle.consumer).toBeNull();
    handle.stop();
  });

  it('starts consumer when resolver + runner + bus + investigations + flag are all set', async () => {
    delete process.env['AUTO_INVESTIGATION_ENABLED'];
    const handle = await startAlerts({
      rules: fakeRepo(),
      setupConfig: fakeSetupConfig(),
      resolveSaIdentity: async () => null,
      runner: {
        saTokens: { validateAndLookup: async () => null },
        makeOrchestrator: () => ({}) as never,
      },
      eventBus: new InMemoryEventBus(),
      investigations: fakeInvestigations(),
    });
    expect(handle.evaluator).not.toBeNull();
    expect(handle.consumer).not.toBeNull();
    handle.stop();
  });
});
