import { describe, it, expect } from 'vitest';
import { TOOL_PERMS, UNGATED_TOOLS, buildToolEvaluator } from './tool-permissions.js';
import { agentRegistry } from './agent-registry.js';
import type { ActionContext } from './orchestrator-action-handlers.js';

/**
 * Minimal ctx stub — only fields the builders consult. Prometheus builders
 * pick up a default datasource from ctx.allDatasources; alert-rule async
 * builders pull the folderUid from the alertRuleStore.
 */
function makeCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    gateway: {} as ActionContext['gateway'],
    model: 'test',
    store: {} as ActionContext['store'],
    investigationReportStore: {} as ActionContext['investigationReportStore'],
    alertRuleStore: {
      findById: async () => null,
    } as unknown as ActionContext['alertRuleStore'],
    allDatasources: [{ id: 'ds-prom', type: 'prometheus', name: 'Prom', url: 'http://x', isDefault: true }],
    sendEvent: () => {},
    sessionId: 'sess-1',
    identity: { userId: 'u', orgId: 'o', orgRole: 'Admin', isServerAdmin: false, authenticatedBy: 'session' },
    accessControl: {
      evaluate: async () => true,
      filterByPermission: async (_id, items) => [...items],
    },
    actionExecutor: {} as ActionContext['actionExecutor'],
    alertRuleAgent: {} as ActionContext['alertRuleAgent'],
    emitAgentEvent: () => {},
    makeAgentEvent: ((type: string) => ({ type, agentType: 'orchestrator', timestamp: '' })) as ActionContext['makeAgentEvent'],
    pushConversationAction: () => {},
    setNavigateTo: () => {},
    ...overrides,
  } as ActionContext;
}

describe('TOOL_PERMS — per-builder scope derivation', () => {
  it('dashboard.create builds a folder-scoped creator evaluator', () => {
    const e = TOOL_PERMS['dashboard.create']!({ folderUid: 'prod' }, makeCtx());
    expect((e as { string: () => string }).string()).toBe(
      'dashboards:create on folders:uid:prod',
    );
  });

  it('dashboard.create defaults to folders:uid:* when folderUid missing', () => {
    const e = TOOL_PERMS['dashboard.create']!({}, makeCtx());
    expect((e as { string: () => string }).string()).toBe(
      'dashboards:create on folders:uid:*',
    );
  });

  it('dashboard.modify_panel scopes to the specific dashboard UID', () => {
    const e = TOOL_PERMS['dashboard.modify_panel']!({ dashboardId: 'abc' }, makeCtx());
    expect((e as { string: () => string }).string()).toBe(
      'dashboards:write on dashboards:uid:abc',
    );
  });

  it('dashboard.list requires read on dashboards:* (per-row filter elsewhere)', () => {
    const e = TOOL_PERMS['dashboard.list']!({}, makeCtx());
    expect((e as { string: () => string }).string()).toBe(
      'dashboards:read on dashboards:*',
    );
  });

  it('prometheus.query maps datasourceId to scope', () => {
    const e = TOOL_PERMS['prometheus.query']!({ datasourceId: 'prom-prod', expr: 'up' }, makeCtx());
    expect((e as { string: () => string }).string()).toBe(
      'datasources:query on datasources:uid:prom-prod',
    );
  });

  it('prometheus.query falls back to the default ctx datasource', () => {
    const e = TOOL_PERMS['prometheus.query']!({ expr: 'up' }, makeCtx());
    expect((e as { string: () => string }).string()).toBe(
      'datasources:query on datasources:uid:ds-prom',
    );
  });

  it('investigation.add_section scopes to the investigation UID', () => {
    const e = TOOL_PERMS['investigation.add_section']!(
      { investigationId: 'inv-7', type: 'text', content: 'x' },
      makeCtx(),
    );
    expect((e as { string: () => string }).string()).toBe(
      'investigations:write on investigations:uid:inv-7',
    );
  });

  it('create_alert_rule is folder-scoped', () => {
    const e = TOOL_PERMS['create_alert_rule']!({ folderUid: 'rules' }, makeCtx());
    expect((e as { string: () => string }).string()).toBe(
      'alert.rules:create on folders:uid:rules',
    );
  });

  it('modify_alert_rule looks up the rule to derive folderUid', async () => {
    const ctx = makeCtx({
      alertRuleStore: {
        findById: async () => ({ id: 'rule-1', folderUid: 'ops' }),
      } as unknown as ActionContext['alertRuleStore'],
    });
    const builder = TOOL_PERMS['modify_alert_rule']!;
    const result = await builder({ ruleId: 'rule-1' }, ctx);
    expect((result as { string: () => string }).string()).toBe(
      'alert.rules:write on folders:uid:ops',
    );
  });

  it('modify_alert_rule falls back to wildcard when rule has no folderUid', async () => {
    const ctx = makeCtx({
      alertRuleStore: {
        findById: async () => ({ id: 'rule-1' }),
      } as unknown as ActionContext['alertRuleStore'],
    });
    const result = await TOOL_PERMS['modify_alert_rule']!({ ruleId: 'rule-1' }, ctx);
    expect((result as { string: () => string }).string()).toBe(
      'alert.rules:write on folders:uid:*',
    );
  });

  it('delete_alert_rule uses the delete action with folder scope', async () => {
    const ctx = makeCtx({
      alertRuleStore: {
        findById: async () => ({ id: 'rule-1', folderUid: 'ops' }),
      } as unknown as ActionContext['alertRuleStore'],
    });
    const result = await TOOL_PERMS['delete_alert_rule']!({ ruleId: 'rule-1' }, ctx);
    expect((result as { string: () => string }).string()).toBe(
      'alert.rules:delete on folders:uid:ops',
    );
  });

  it('web.search requires chat:use with no scope', () => {
    const e = TOOL_PERMS['web.search']!({}, makeCtx());
    expect((e as { string: () => string }).string()).toBe('chat:use');
  });
});

describe('buildToolEvaluator', () => {
  it('returns null for ungated UI tools', async () => {
    for (const t of UNGATED_TOOLS) {
      expect(await buildToolEvaluator(t, {}, makeCtx())).toBeNull();
    }
  });

  it('returns a sentinel evaluator for unknown tools (fail closed)', async () => {
    const e = await buildToolEvaluator('not.a.real.tool', {}, makeCtx());
    expect(e).not.toBeNull();
    expect((e as { string: () => string }).string()).toContain('agent:unknown_tool');
  });
});

describe('TOOL_PERMS — catalog completeness invariant', () => {
  it('every non-terminal tool on every registered agent is in TOOL_PERMS or UNGATED_TOOLS', () => {
    const uncovered: { agent: string; tool: string }[] = [];
    for (const def of agentRegistry.getAll()) {
      for (const tool of def.allowedTools) {
        if (UNGATED_TOOLS.has(tool)) continue;
        if (TOOL_PERMS[tool]) continue;
        uncovered.push({ agent: def.type, tool });
      }
    }
    expect(uncovered).toEqual([]);
  });
});
