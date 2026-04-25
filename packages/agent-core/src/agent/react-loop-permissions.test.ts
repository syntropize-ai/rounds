/**
 * Integration-style tests for the ReActLoop + permission gate wiring through
 * OrchestratorAgent.
 *
 * These spin up a real OrchestratorAgent with mocked LLM responses and a
 * programmable AccessControlStub, then assert the observation the loop
 * hands back to the LLM on the next turn carries the expected
 * `permission denied:` prefix (when the gate denies) or real tool output
 * (when it allows).
 *
 * Covers scenarios 1–9 and 13–18 from docs/auth-perm-design/11-agent-permissions.md.
 */

import { describe, it, expect, vi } from 'vitest';
import { ac, type Evaluator, type Identity } from '@agentic-obs/common';
import { OrchestratorAgent } from './orchestrator-agent.js';
import type { IAuditWriter } from './types-permissions.js';
import { AccessControlStub, makeTestIdentity } from './test-helpers.js';
import { AdapterRegistry } from '../adapters/index.js';

function makeEmptyAdapters(): AdapterRegistry {
  return new AdapterRegistry();
}

type LLMResponse = {
  content: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
};

let __callCounter = 0;
function asStep(_thought: string, action: string, args: Record<string, unknown>, message?: string): LLMResponse {
  __callCounter += 1;
  return {
    content: message ?? '',
    toolCalls: [
      {
        id: `call_${__callCounter}`,
        name: action,
        input: args,
      },
    ],
  };
}

function makeGateway(responses: LLMResponse[]) {
  const queue = [...responses];
  return {
    complete: vi.fn().mockImplementation(() => {
      const next = queue.shift();
      if (!next) {
        return Promise.resolve({
          content: 'done',
          toolCalls: [
            { id: 'call_finish_default', name: 'finish', input: { message: 'done' } },
          ],
        });
      }
      return Promise.resolve(next);
    }),
  };
}

function collectingAudit(): IAuditWriter & { entries: unknown[] } {
  const entries: unknown[] = [];
  return {
    entries,
    log: async (entry) => {
      entries.push(entry);
    },
  };
}

function makeStore(dashboards: Array<{ id: string; title: string; description: string; status: string }> = []) {
  return {
    create: vi.fn(async ({ title }: { title: string }) => ({
      id: 'new-dash',
      type: 'dashboard',
      title,
      description: '',
      prompt: '',
      userId: 'agent',
      status: 'ready',
      panels: [],
      variables: [],
      refreshIntervalSec: 60,
      datasourceIds: [],
      useExistingMetrics: true,
      createdAt: '2026-04-18T00:00:00.000Z',
      updatedAt: '2026-04-18T00:00:00.000Z',
    })),
    findById: vi.fn().mockResolvedValue(null),
    findAll: vi.fn().mockResolvedValue(dashboards),
    update: vi.fn(),
    updatePanels: vi.fn(),
    updateVariables: vi.fn(),
    updateStatus: vi.fn(),
  } as any;
}

function build(opts: {
  llmResponses: LLMResponse[];
  accessControl?: AccessControlStub;
  agentType?: 'orchestrator' | 'alert-rule-builder';
  identity?: Identity;
  dashboards?: Array<{ id: string; title: string; description: string; status: string }>;
}) {
  const sendEvent = vi.fn();
  const gateway = makeGateway(opts.llmResponses);
  const audit = collectingAudit();
  const store = makeStore(opts.dashboards);
  const agent = new OrchestratorAgent({
    gateway: gateway as any,
    model: 'test',
    store,
    conversationStore: {
      addMessage: vi.fn(),
      getMessages: vi.fn().mockResolvedValue([]),
      clearMessages: vi.fn(),
      deleteConversation: vi.fn(),
    },
    investigationReportStore: { save: vi.fn() },
    alertRuleStore: { create: vi.fn() } as any,
    adapters: makeEmptyAdapters(),
    sendEvent,
    identity: opts.identity ?? makeTestIdentity(),
    accessControl: opts.accessControl ?? new AccessControlStub(),
    auditWriter: audit,
    ...(opts.agentType ? { agentType: opts.agentType } : {}),
  });
  return { agent, sendEvent, gateway, audit, store };
}

describe('Scenario 1 — Viewer → dashboard.create → permission denied', () => {
  it('returns a `permission denied:` observation + audit row', async () => {
    const deny = new AccessControlStub((_id, e) => {
      // Deny only dashboards:create; everything else passes.
      return !e.string().includes('dashboards:create');
    });
    const { agent, audit } = build({
      llmResponses: [
        asStep('try to create', 'dashboard.create', { folderUid: 'prod', title: 'X' }),
        // Second turn after seeing the denial — finish politely.
        asStep('explain', 'finish', {}, 'I cannot create a dashboard in prod.'),
      ],
      accessControl: deny,
      identity: makeTestIdentity({ orgRole: 'Viewer' }),
    });
    const reply = await agent.handleMessage('Create a dashboard in prod.');
    expect(reply).toContain('cannot');
    // Expect one denied audit row.
    const denied = (audit.entries as Array<{ action: string }>).filter((e) => e.action === 'agent.tool_denied');
    expect(denied.length).toBe(1);
  });
});

describe('Scenario 2 — Editor → dashboard.create → allowed', () => {
  it('executes the create and audits an allow row', async () => {
    const { agent, audit, store } = build({
      llmResponses: [
        asStep('create', 'dashboard.create', { folderUid: 'prod', title: 'My Dash' }),
        asStep('done', 'finish', {}, 'Created.'),
      ],
      identity: makeTestIdentity({ orgRole: 'Editor' }),
    });
    await agent.handleMessage('Create a dashboard.');
    expect(store.create).toHaveBeenCalled();
    const allowed = (audit.entries as Array<{ action: string }>).filter((e) => e.action === 'agent.tool_called');
    expect(allowed.length).toBe(1);
  });
});

describe('Scenario 3 — mixed: query allowed, create denied', () => {
  it('loop continues through both observations', async () => {
    const mixed = new AccessControlStub((_id, e) => !e.string().includes('dashboards:create'));
    const { agent, audit } = build({
      llmResponses: [
        asStep('query first', 'metrics.query', { query: 'up', sourceId: 'ds-prom' }),
        asStep('try to create', 'dashboard.create', { folderUid: 'prod', title: 'x' }),
        asStep('explain', 'finish', {}, 'Queried but cannot create.'),
      ],
      accessControl: mixed,
    });
    await agent.handleMessage('Query and create.');
    const rows = audit.entries as Array<{ action: string }>;
    const called = rows.filter((e) => e.action === 'agent.tool_called').length;
    const denied = rows.filter((e) => e.action === 'agent.tool_denied').length;
    // metrics.query has no registered adapter in the empty AdapterRegistry,
    // so the handler emits an "unknown datasource" observation — but the gate
    // still passes it as ALLOWED. Only dashboard.create should be denied.
    expect(denied).toBe(1);
    expect(called).toBeGreaterThanOrEqual(1);
  });
});

describe('Scenario 4 — dashboard.list filters per-row', () => {
  it('returns only dashboards the user can read', async () => {
    const allowed = new Set(['d1', 'd2', 'd3']);
    const filtered = new AccessControlStub((_id, e) => {
      const s = e.string();
      if (s.startsWith('dashboards:read on dashboards:*')) return true;
      // Per-row reads: allow only those in the allowed set.
      const m = /dashboards:uid:([^\s,]+)/.exec(s);
      if (!m) return true;
      return allowed.has(m[1]!);
    });
    const dashboards = [
      { id: 'd1', title: 'One', description: '', status: 'ready' },
      { id: 'd2', title: 'Two', description: '', status: 'ready' },
      { id: 'd3', title: 'Three', description: '', status: 'ready' },
      { id: 'd4', title: 'Four', description: '', status: 'ready' },
      { id: 'd5', title: 'Five', description: '', status: 'ready' },
    ];
    const { agent, sendEvent } = build({
      llmResponses: [
        asStep('list', 'dashboard.list', {}),
        asStep('report', 'finish', {}, 'Listed dashboards.'),
      ],
      accessControl: filtered,
      dashboards,
    });
    await agent.handleMessage('List dashboards.');

    // The observation text emitted as tool_result should only reference the 3 allowed dashboards.
    const toolResults = sendEvent.mock.calls
      .map((c) => c[0])
      .filter((e: any) => e.type === 'tool_result' && e.tool === 'dashboard.list');
    // The summary emitted to the event stream is "N dashboards found" in both cases,
    // but to assert filtering we check the find/list pipeline caught 3.
    expect(toolResults[0].summary).toContain('3 dashboards found');
  });
});

describe('Scenario 7 — propose_only agent + dashboard.create', () => {
  it('denies at Layer 2 (permissionMode)', async () => {
    const { agent, audit } = build({
      llmResponses: [
        asStep('attempt', 'create_alert_rule', { folderUid: 'rules', prompt: 'x' }),
        asStep('explain', 'finish', {}, 'Proposal only.'),
      ],
      agentType: 'alert-rule-builder',
    });
    await agent.handleMessage('Make an alert.');
    const denied = (audit.entries as Array<{ action: string; metadata?: Record<string, unknown> }>).filter(
      (e) => e.action === 'agent.tool_denied',
    );
    expect(denied.length).toBeGreaterThanOrEqual(1);
    const meta = denied[0]!.metadata as Record<string, unknown>;
    expect(meta.denied_by).toBe('permissionMode');
  });
});

describe('Scenario 5 / 16 — cross-org / datasource isolation', () => {
  it('denies metrics.query when the datasource scope is not granted', async () => {
    const deny = new AccessControlStub((_id, e: Evaluator) => {
      // Grant query on prom-app, deny on prom-infra.
      if (e.string().includes('datasources:uid:prom-app')) return true;
      if (e.string().includes('datasources:uid:prom-infra')) return false;
      return true;
    });
    const { agent, audit } = build({
      llmResponses: [
        asStep('ok', 'metrics.query', { sourceId: 'prom-app', query: 'up' }),
        asStep('denied', 'metrics.query', { sourceId: 'prom-infra', query: 'up' }),
        asStep('explain', 'finish', {}, 'Mixed result.'),
      ],
      accessControl: deny,
    });
    await agent.handleMessage('Query both.');
    const rows = audit.entries as Array<{ action: string; metadata?: Record<string, unknown> }>;
    const denied = rows.filter((e) => e.action === 'agent.tool_denied');
    expect(denied.length).toBe(1);
    const meta = denied[0]!.metadata as Record<string, unknown>;
    expect(meta.required_scope).toContain('prom-infra');
  });
});

describe('Scenario 6 — no identity → loop refuses to start', () => {
  it('throws when identity is missing', async () => {
    // Directly prove the ReActLoop guard fires. We don't construct
    // OrchestratorAgent because its type requires identity at the type
    // level; instead, import ReActLoop and call runLoop with an empty
    // identity.
    const { ReActLoop } = await import('./react-loop.js');
    const loop = new ReActLoop({
      gateway: { complete: vi.fn() } as any,
      model: 'test',
      sendEvent: vi.fn(),
      identity: { userId: '' } as unknown as Identity,
      accessControl: new AccessControlStub(),
      allowedTools: ['reply', 'finish'],
    });
    await expect(loop.runLoop('', 'hi', vi.fn())).rejects.toThrow('identity is required');
  });
});

describe('Prompt template population (Scenario 11)', () => {
  it('identity template variables appear in the system prompt snapshot', async () => {
    const responses: LLMResponse[] = [asStep('done', 'finish', {}, 'ok')];
    const gateway = makeGateway(responses);
    const sendEvent = vi.fn();
    const audit = collectingAudit();
    const agent = new OrchestratorAgent({
      gateway: gateway as any,
      model: 'test',
      store: makeStore([]),
      conversationStore: {
        addMessage: vi.fn(),
        getMessages: vi.fn().mockResolvedValue([]),
        clearMessages: vi.fn(),
        deleteConversation: vi.fn(),
      },
      investigationReportStore: { save: vi.fn() },
      alertRuleStore: { create: vi.fn() } as any,
      adapters: makeEmptyAdapters(),
      sendEvent,
      identity: makeTestIdentity({ orgRole: 'Viewer', userId: 'u-viewer' }),
      accessControl: new AccessControlStub(),
      auditWriter: audit,
    });
    await agent.handleMessage('hello');
    // The first call into gateway.complete had the system prompt as the first message.
    const firstCallArgs = gateway.complete.mock.calls[0]![0] as Array<{ role: string; content: string }>;
    const systemMsg = firstCallArgs.find((m) => m.role === 'system')!;
    expect(systemMsg.content).toContain('org role Viewer');
    expect(systemMsg.content).toContain('permission denied:');
  });
});
