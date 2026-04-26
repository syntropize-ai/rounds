import { describe, it, expect } from 'vitest';
import { TOOL_PERMS, UNGATED_TOOLS, buildToolEvaluator } from './tool-permissions.js';
import { agentRegistry } from './agent-registry.js';
import type { ActionContext } from './orchestrator-action-handlers.js';
import { AdapterRegistry } from '../adapters/index.js';

/**
 * Minimal ctx stub — only fields the builders consult. Metrics/logs/changes
 * builders take `sourceId` straight from args; alert-rule async builders
 * pull the folderUid from the alertRuleStore.
 */
function makeCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    gateway: {} as ActionContext['gateway'],
    model: 'test',
    store: {} as ActionContext['store'],
    investigationReportStore: {} as ActionContext['investigationReportStore'],
    alertRuleStore: {
      findById: async () => null,
      getFolderUid: async () => null,
    } as unknown as ActionContext['alertRuleStore'],
    adapters: new AdapterRegistry(),
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

  it('metrics.query maps sourceId to scope', () => {
    const e = TOOL_PERMS['metrics.query']!({ sourceId: 'prom-prod', query: 'up' }, makeCtx());
    expect((e as { string: () => string }).string()).toBe(
      'datasources:query on datasources:uid:prom-prod',
    );
  });

  it('metrics.query falls back to wildcard when sourceId is missing', () => {
    const e = TOOL_PERMS['metrics.query']!({ query: 'up' }, makeCtx());
    expect((e as { string: () => string }).string()).toBe(
      'datasources:query on datasources:uid:*',
    );
  });

  it('logs.query derives the datasource scope from sourceId', () => {
    const e = TOOL_PERMS['logs.query']!({ sourceId: 'loki-prod' }, makeCtx());
    expect((e as { string: () => string }).string()).toBe(
      'datasources:query on datasources:uid:loki-prod',
    );
  });

  it('changes.list_recent requires investigations:read', () => {
    const e = TOOL_PERMS['changes.list_recent']!({}, makeCtx());
    expect((e as { string: () => string }).string()).toBe(
      'investigations:read on investigations:*',
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
        getFolderUid: async () => 'ops',
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
        getFolderUid: async () => null,
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
        getFolderUid: async () => 'ops',
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
