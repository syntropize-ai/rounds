import { describe, it, expect, vi } from 'vitest';
import { AgentConfigServiceImpl } from './agent-config-service.js';
import type { ConnectorService } from './connector-service.js';

function fakeConnectorService(over: Partial<ConnectorService> = {}): ConnectorService {
  return {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(async (input: Record<string, unknown>) => ({
      id: 'conn_1',
      status: 'active',
      ...input,
    })),
    test: vi.fn().mockResolvedValue({ ok: true, capabilities: ['metrics.query'] }),
    ...over,
  } as unknown as ConnectorService;
}

describe('AgentConfigServiceImpl — connector proposal', () => {
  it('creates nothing until the draft is applied', async () => {
    const connectors = fakeConnectorService();
    const svc = new AgentConfigServiceImpl({ connectors });

    const draft = await svc.proposeConnector({
      orgId: 'org_a',
      template: 'prometheus',
      name: 'cluster-prometheus',
      config: { url: 'http://prometheus.monitoring.svc.cluster.local:9090' },
    });

    expect(draft.draftId).toBeTruthy();
    expect(connectors.create).not.toHaveBeenCalled();

    const applied = await svc.applyConnectorDraft({ orgId: 'org_a', draftId: draft.draftId });
    expect(connectors.create).toHaveBeenCalledTimes(1);
    expect(applied.connectorId).toBe('conn_1');
  });

  it('refuses a template it does not know instead of creating something odd', async () => {
    const connectors = fakeConnectorService();
    const svc = new AgentConfigServiceImpl({ connectors });

    await expect(
      svc.proposeConnector({ orgId: 'org_a', template: 'not-a-backend', name: 'x', config: {} }),
    ).rejects.toThrow(/Unknown connector template/);
    expect(connectors.create).not.toHaveBeenCalled();
  });

  it('names the missing required fields rather than creating a broken connector', async () => {
    const connectors = fakeConnectorService();
    const svc = new AgentConfigServiceImpl({ connectors });

    await expect(
      svc.proposeConnector({ orgId: 'org_a', template: 'prometheus', name: 'p', config: {} }),
    ).rejects.toThrow(/url/);
    expect(connectors.create).not.toHaveBeenCalled();
  });

  it('will not apply the same draft twice', async () => {
    const connectors = fakeConnectorService();
    const svc = new AgentConfigServiceImpl({ connectors });
    const draft = await svc.proposeConnector({
      orgId: 'org_a',
      template: 'prometheus',
      name: 'p',
      config: { url: 'http://prom:9090' },
    });

    await svc.applyConnectorDraft({ orgId: 'org_a', draftId: draft.draftId });
    await expect(
      svc.applyConnectorDraft({ orgId: 'org_a', draftId: draft.draftId }),
    ).rejects.toThrow(/expired or was already applied/);
    expect(connectors.create).toHaveBeenCalledTimes(1);
  });

  it('will not apply a draft belonging to another org', async () => {
    const connectors = fakeConnectorService();
    const svc = new AgentConfigServiceImpl({ connectors });
    const draft = await svc.proposeConnector({
      orgId: 'org_a',
      template: 'prometheus',
      name: 'p',
      config: { url: 'http://prom:9090' },
    });

    await expect(
      svc.applyConnectorDraft({ orgId: 'org_b', draftId: draft.draftId }),
    ).rejects.toThrow(/expired or was already applied/);
    expect(connectors.create).not.toHaveBeenCalled();
  });

  it('tells the agent a secret is still required, without handling one', async () => {
    const svc = new AgentConfigServiceImpl({ connectors: fakeConnectorService() });
    const draft = await svc.proposeConnector({
      orgId: 'org_a',
      template: 'prometheus',
      name: 'p',
      config: { url: 'http://prom:9090' },
    });
    // The prometheus template declares `credential: 'token'`, so the agent is
    // told a secret is still needed — it must not invent one.
    expect(draft.needsCredential).toBe(true);
    expect(draft.capabilityPreview).toContain('metrics.query');
  });
});

describe('AgentConfigServiceImpl — templates', () => {
  it('lists prometheus with its required fields so the agent can ask for them', async () => {
    const svc = new AgentConfigServiceImpl({ connectors: fakeConnectorService() });
    const templates = await svc.listConnectorTemplates({});
    const prom = templates.find((t) => t.type === 'prometheus');

    expect(prom).toBeDefined();
    expect(prom?.requiredFields).toContain('url');
    expect(prom?.credentialRequired).toBe(true);
  });
});

describe('AgentConfigServiceImpl — settings', () => {
  it('refuses a key that is not on the agent allowlist', async () => {
    const setSetting = vi.fn();
    const svc = new AgentConfigServiceImpl({
      connectors: fakeConnectorService(),
      settings: { getSetting: vi.fn().mockResolvedValue(null), setSetting },
    });

    await expect(
      svc.setSetting('auth.session_ttl', '5m', { orgId: 'org_a', userId: 'u1' }),
    ).rejects.toThrow(/cannot be changed from chat/);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('writes an allowlisted key', async () => {
    const setSetting = vi.fn();
    const svc = new AgentConfigServiceImpl({
      connectors: fakeConnectorService(),
      settings: { getSetting: vi.fn().mockResolvedValue(null), setSetting },
    });

    await svc.setSetting('investigation.default_time_range', '6h', {
      orgId: 'org_a',
      userId: 'u1',
    });
    expect(setSetting).toHaveBeenCalledWith('investigation.default_time_range', '6h');
  });

  it('fails loudly when no settings store is wired rather than pretending to save', async () => {
    const svc = new AgentConfigServiceImpl({ connectors: fakeConnectorService() });
    await expect(
      svc.setSetting('investigation.default_time_range', '6h', { orgId: 'org_a', userId: 'u1' }),
    ).rejects.toThrow(/not available/);
  });
});
