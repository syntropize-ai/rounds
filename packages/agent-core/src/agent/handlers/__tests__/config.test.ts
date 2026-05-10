import { describe, it, expect, vi } from 'vitest';
import { TOOL_REGISTRY } from '../../tool-schema-registry.js';
import { buildSystemPrompt } from '../../orchestrator-prompt.js';
import {
  handleConnectorApply,
  handleConnectorList,
  handleConnectorPropose,
  handleConnectorTest,
  handleSettingSet,
} from '../config.js';
import { makeFakeActionContext } from '../_test-helpers.js';
import type { AgentConfigService } from '../../types.js';

function makeStubConfigService(): AgentConfigService {
  return {
    listConnectors: vi.fn().mockResolvedValue([{
      id: 'conn-prom',
      type: 'prometheus',
      name: 'prod-prom',
      category: ['observability'],
      capabilities: ['metrics.query'],
      status: 'active',
      defaultFor: 'prometheus',
    }]),
    listConnectorTemplates: vi.fn().mockResolvedValue([{
      type: 'prometheus',
      category: ['observability'],
      capabilities: ['metrics.query', 'metrics.discover'],
      requiredFields: ['url'],
      credentialRequired: false,
    }]),
    detectConnectors: vi.fn().mockResolvedValue([]),
    proposeConnector: vi.fn().mockResolvedValue({
      draftId: 'draft-1',
      needsCredential: false,
      capabilityPreview: ['metrics.query'],
    }),
    applyConnectorDraft: vi.fn().mockResolvedValue({
      connectorId: 'conn-prom',
      status: 'active',
      capabilities: ['metrics.query'],
    }),
    testConnector: vi.fn().mockResolvedValue({
      ok: true,
      latencyMs: 12,
      capabilities: ['metrics.query'],
    }),
    getSetting: vi.fn().mockResolvedValue(null),
    setSetting: vi.fn().mockResolvedValue(undefined),
  };
}

describe('tool schema registry — connector model entries', () => {
  it('registers connector tools', () => {
    expect(TOOL_REGISTRY['connector_list']).toBeDefined();
    expect(TOOL_REGISTRY['connector_propose']!.schema.input_schema?.required).toEqual(
      expect.arrayContaining(['template', 'name', 'config']),
    );
    expect(TOOL_REGISTRY['connector_apply']!.schema.input_schema?.required).toEqual(['draftId']);
    expect(TOOL_REGISTRY['connector_test']!.schema.input_schema?.required).toEqual(['connectorId']);
  });

  it('registers setting_get and setting_set with the full allowlist', () => {
    const props = TOOL_REGISTRY['setting_set']!.schema.input_schema?.properties as Record<string, { enum?: string[] }>;
    expect(props['key']?.enum).toEqual(expect.arrayContaining([
      'default_alert_folder_uid',
      'default_dashboard_folder_uid',
      'notification_default_channel',
      'auto_investigation_enabled',
    ]));
  });
});

describe('connector handlers', () => {
  it('lists connectors through the new service surface', async () => {
    const configService = makeStubConfigService();
    const ctx = makeFakeActionContext({ configService });
    const result = await handleConnectorList(ctx, { capability: 'metrics.query' });

    expect(result).toContain('conn-prom');
    expect(configService.listConnectors).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'metrics.query' }),
    );
  });

  it('proposes a connector draft and emits redacted SSE', async () => {
    const configService = makeStubConfigService();
    const ctx = makeFakeActionContext({ configService });
    const result = await handleConnectorPropose(ctx, {
      template: 'prometheus',
      name: 'prod-prom',
      config: { url: 'http://prom.local' },
      isDefault: true,
    });

    expect(result).toContain('draftId: draft-1');
    expect(configService.proposeConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        template: 'prometheus',
        config: { url: 'http://prom.local' },
        isDefault: true,
      }),
    );
    const payload = JSON.stringify((ctx.sendEvent as unknown as { mock: { calls: unknown[][] } }).mock.calls);
    expect(payload).not.toContain('raw-secret');
  });

  it('rejects raw credentials inside connector config', async () => {
    const ctx = makeFakeActionContext({ configService: makeStubConfigService() });
    const result = await handleConnectorPropose(ctx, {
      template: 'github',
      name: 'prod-github',
      config: { org: 'acme', token: 'raw-secret' },
    });

    expect(result).toMatch(/Refusing to accept raw config.token/);
  });

  it('applies and tests connectors', async () => {
    const configService = makeStubConfigService();
    const ctx = makeFakeActionContext({ configService });

    await expect(handleConnectorApply(ctx, { draftId: 'draft-1' })).resolves.toContain('connectorId=conn-prom');
    await expect(handleConnectorTest(ctx, { connectorId: 'conn-prom' })).resolves.toContain('test OK');
  });
});

describe('setting handlers', () => {
  it('sets an allowlisted notification setting', async () => {
    const configService = makeStubConfigService();
    const ctx = makeFakeActionContext({ configService });
    const result = await handleSettingSet(ctx, {
      key: 'notification_default_channel',
      value: 'slack-prod',
    });

    expect(result).toContain('Set "notification_default_channel" to "slack-prod".');
    expect(configService.setSetting).toHaveBeenCalledWith(
      'notification_default_channel',
      'slack-prod',
      { orgId: expect.any(String), userId: expect.any(String) },
    );
  });

  it('rejects keys outside the allowlist', async () => {
    const ctx = makeFakeActionContext({ configService: makeStubConfigService() });
    const result = await handleSettingSet(ctx, { key: 'admin_role', value: 'editor' });
    expect(result).toMatch(/not in the AI-configurable settings allowlist/);
  });
});

describe('orchestrator prompt', () => {
  it('mentions connector and setting tools', () => {
    const prompt = buildSystemPrompt(null, [], [], null, [], { hasPrometheus: false });
    expect(prompt).toContain('connector_propose');
    expect(prompt).toContain('setting_set');
  });
});
