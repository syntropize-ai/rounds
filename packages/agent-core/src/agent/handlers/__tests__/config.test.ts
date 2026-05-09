/**
 * Unit tests for the AI-first configuration handlers (Task 07).
 *
 * Asserts:
 *   - tool schemas exist and the registry has the expected required fields
 *   - happy-path datasource_configure calls the service and emits a
 *     redacted SSE payload (no secret leaks)
 *   - happy-path ops_connector_configure with a mocked runner
 *   - low-risk system_setting_configure path (default alert folder)
 *   - allowlist enforcement on system_setting_configure
 *   - raw-credential rejection on all three handlers
 *   - orchestrator-prompt mentions the new tools
 */

import { describe, it, expect, vi } from 'vitest';
import { TOOL_REGISTRY } from '../../tool-schema-registry.js';
import { buildSystemPrompt } from '../../orchestrator-prompt.js';
import {
  handleDatasourceConfigure,
  handleOpsConnectorConfigure,
  handleSystemSettingConfigure,
} from '../config.js';
import { makeFakeActionContext } from '../_test-helpers.js';
import type { AgentConfigService } from '../../types.js';

function makeStubConfigService(): AgentConfigService {
  return {
    upsertDatasource: vi.fn().mockResolvedValue({
      id: 'ds-new',
      type: 'prometheus',
      name: 'prod-prom',
      url: 'http://prom.local',
    }),
    testDatasource: vi.fn().mockResolvedValue({ ok: true, message: 'reachable' }),
    upsertOpsConnector: vi.fn().mockResolvedValue({
      id: 'ops-1',
      name: 'prod-cluster',
      type: 'kubernetes',
    }),
    testOpsConnector: vi.fn().mockResolvedValue({
      ok: true,
      message: 'kubectl version ok',
      status: 'connected',
    }),
    getInstanceSetting: vi.fn().mockResolvedValue(null),
    setInstanceSetting: vi.fn().mockResolvedValue(undefined),
  };
}

describe('tool schema registry — Task 07 entries', () => {
  it('datasource_configure exists and requires type, name, url', () => {
    const e = TOOL_REGISTRY['datasource_configure'];
    expect(e).toBeDefined();
    expect(e!.schema.input_schema?.required).toEqual(
      expect.arrayContaining(['type', 'name', 'url']),
    );
    // The schema must NOT expose raw credential fields.
    const props = e!.schema.input_schema?.properties as Record<string, unknown>;
    expect(props).not.toHaveProperty('password');
    expect(props).not.toHaveProperty('apiKey');
    expect(props).not.toHaveProperty('token');
  });

  it('ops_connector_configure exists and requires name', () => {
    const e = TOOL_REGISTRY['ops_connector_configure'];
    expect(e).toBeDefined();
    expect(e!.schema.input_schema?.required).toEqual(
      expect.arrayContaining(['name']),
    );
  });

  it('system_setting_configure exists with allowlisted enum', () => {
    const e = TOOL_REGISTRY['system_setting_configure'];
    expect(e).toBeDefined();
    const props = e!.schema.input_schema?.properties as Record<string, { enum?: string[] }>;
    expect(props['key']?.enum).toEqual(
      expect.arrayContaining(['default_alert_folder_uid', 'default_dashboard_folder_uid']),
    );
  });
});

describe('handleDatasourceConfigure', () => {
  it('happy path: creates datasource and emits redacted SSE', async () => {
    const configService = makeStubConfigService();
    const ctx = makeFakeActionContext({ configService });
    const result = await handleDatasourceConfigure(ctx, {
      type: 'prometheus',
      name: 'prod-prom',
      url: 'http://prom.local',
      secretRef: 'sec-123',
      test: true,
    });
    expect(result).toContain('Created prometheus datasource');
    expect(result).toContain('Connection test OK');
    expect(configService.upsertDatasource).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'prometheus', secretRef: 'sec-123' }),
    );
    // SSE event #0 is the tool_call — its args must be redacted/no raw secret.
    const calls = (ctx.sendEvent as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const toolCall = calls.find((c) => (c[0] as { type?: string }).type === 'tool_call');
    expect(toolCall).toBeDefined();
    const payload = JSON.stringify(toolCall![0]);
    expect(payload).not.toContain('password');
    expect(payload).not.toContain('raw-secret');
  });

  it('rejects raw credentials in args', async () => {
    const ctx = makeFakeActionContext({ configService: makeStubConfigService() });
    const result = await handleDatasourceConfigure(ctx, {
      type: 'prometheus',
      name: 'p',
      url: 'http://p',
      password: 'raw-secret',
    });
    expect(result).toMatch(/Refusing to accept raw "password"/);
    // Even when rejected, no secret leaks in SSE.
    const calls = (ctx.sendEvent as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(JSON.stringify(calls)).not.toContain('raw-secret');
  });

  it('returns needs_credential when service flags secretMissing', async () => {
    const configService = makeStubConfigService();
    (configService.upsertDatasource as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'ds-x',
      type: 'elasticsearch',
      name: 'es-prod',
      url: 'http://es',
      secretMissing: true,
    });
    const ctx = makeFakeActionContext({ configService });
    const result = await handleDatasourceConfigure(ctx, {
      type: 'elasticsearch',
      name: 'es-prod',
      url: 'http://es',
    });
    expect(result).toMatch(/needs_credential/);
    expect(result).toContain('/settings/datasources/ds-x');
  });
});

describe('handleOpsConnectorConfigure', () => {
  it('happy path with mocked runner', async () => {
    const configService = makeStubConfigService();
    const ctx = makeFakeActionContext({ configService });
    const result = await handleOpsConnectorConfigure(ctx, {
      type: 'kubernetes',
      name: 'prod-cluster',
      secretRef: 'sec-kube',
      allowedNamespaces: ['app'],
    });
    expect(result).toContain('Created kubernetes ops connector');
    expect(result).toContain('Connection test OK');
    expect(configService.upsertOpsConnector).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'prod-cluster', secretRef: 'sec-kube' }),
    );
  });

  it('rejects raw token', async () => {
    const ctx = makeFakeActionContext({ configService: makeStubConfigService() });
    const result = await handleOpsConnectorConfigure(ctx, {
      name: 'k',
      token: 'kube-bearer',
    });
    expect(result).toMatch(/Refusing to accept raw "token"/);
  });
});

describe('handleSystemSettingConfigure', () => {
  it('low-risk path: change default alert folder', async () => {
    const configService = makeStubConfigService();
    const ctx = makeFakeActionContext({ configService });
    const result = await handleSystemSettingConfigure(ctx, {
      key: 'default_alert_folder_uid',
      value: 'alerts-prod',
    });
    expect(result).toContain('Set "default_alert_folder_uid" to "alerts-prod".');
    expect(configService.setInstanceSetting).toHaveBeenCalledWith(
      'default_alert_folder_uid',
      'alerts-prod',
      { userId: expect.any(String) },
    );
  });

  it('rejects keys outside the allowlist', async () => {
    const ctx = makeFakeActionContext({ configService: makeStubConfigService() });
    const result = await handleSystemSettingConfigure(ctx, {
      key: 'admin_role',
      value: 'editor',
    });
    expect(result).toMatch(/not in the AI-configurable allowlist/);
  });
});

describe('orchestrator prompt', () => {
  it('mentions the AI-first configuration tools', () => {
    const prompt = buildSystemPrompt(null, [], [], null, [], { hasPrometheus: false });
    expect(prompt).toContain('datasource_configure');
    expect(prompt).toContain('ops_connector_configure');
    expect(prompt).toContain('system_setting_configure');
  });
});
