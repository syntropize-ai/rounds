/**
 * Tests for the schema-driven required-arg check in
 * PermissionWrappedActionRunner.execute. Covers the generic missing-arg path
 * and the alert_rule_write op=create folderUid auto-fill.
 */

import { describe, it, expect, vi } from 'vitest';
import { PermissionWrappedActionRunner } from './orchestrator-action-runner.js';
import type { AgentDefinition } from './agent-definition.js';
import type { ToolAuditReporter } from './orchestrator-audit-reporter.js';
import type { ReActStep } from './react-loop.js';
import { agentRegistry } from './agent-registry.js';
import { makeFakeActionContext } from './handlers/_test-helpers.js';
import type { ActionContext } from './handlers/_context.js';

function makeRunner() {
  const sendEvent = vi.fn();
  const emitAgentEvent = vi.fn();
  const auditReporter: ToolAuditReporter = {
    writeToolAudit: vi.fn().mockResolvedValue(undefined),
  } as unknown as ToolAuditReporter;
  const agentDef = agentRegistry.get('orchestrator') as AgentDefinition;
  const runner = new PermissionWrappedActionRunner({
    agentDef,
    auditReporter,
    sendEvent,
    emitAgentEvent,
    makeAgentEvent: (type, metadata) => ({ type, agentType: 'orchestrator', timestamp: '', metadata }) as never,
  });
  return { runner, sendEvent, auditReporter };
}

function fakeFolderRepo(folders: Array<{ uid: string; title: string; parentUid?: string | null }>) {
  return {
    list: vi.fn().mockResolvedValue({ items: folders, total: folders.length }),
    create: vi.fn(),
    findById: vi.fn(),
    findByUid: vi.fn(),
    listAncestors: vi.fn(),
    listChildren: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  } as unknown as ActionContext['folderRepository'];
}

describe('PermissionWrappedActionRunner — required-arg validation', () => {
  it('returns a clarifying observation and does not invoke the handler when a required arg is missing', async () => {
    const { runner, sendEvent, auditReporter } = makeRunner();
    const ctx = makeFakeActionContext();
    // metrics_query requires sourceId + query; pass query only.
    const step: ReActStep = { thought: '', action: 'metrics_query', args: { query: 'up' } };

    const observation = await runner.execute(step, ctx);

    expect(observation).toMatch(/missing required argument.*sourceId/);
    // No handler dispatch ⇒ no tool_call event was sent (only the failure tool_result).
    const toolCalls = sendEvent.mock.calls.filter(([e]) => e.type === 'tool_call');
    expect(toolCalls).toHaveLength(0);
    const failureResult = sendEvent.mock.calls.find(
      ([e]) => e.type === 'tool_result' && e.tool === 'metrics_query' && e.success === false,
    );
    expect(failureResult).toBeDefined();
    // No allow audit row for a tool that never ran.
    expect((auditReporter.writeToolAudit as ReturnType<typeof vi.fn>)).not.toHaveBeenCalledWith('allow', expect.anything(), expect.anything(), expect.anything());
  });

  it('auto-fills folderUid for alert_rule_write op=create when exactly one folder is visible', async () => {
    const { runner } = makeRunner();
    const folderRepo = fakeFolderRepo([{ uid: 'general', title: 'General', parentUid: null }]);
    const alertRuleAgent = {
      generate: vi.fn().mockResolvedValue({
        rule: {
          name: 'High latency',
          description: 'd',
          condition: { query: 'up', operator: '>', threshold: 1, forDurationSec: 60 },
          evaluationIntervalSec: 60,
          severity: 'high',
          labels: {},
        },
      }),
    };
    const created: Array<Record<string, unknown>> = [];
    const ctx = makeFakeActionContext({
      folderRepository: folderRepo,
      alertRuleAgent: alertRuleAgent as unknown as ActionContext['alertRuleAgent'],
      alertRuleStore: {
        create: vi.fn(async (input: Record<string, unknown>) => {
          created.push(input);
          return { id: 'rule-1', ...input } as never;
        }),
      } as unknown as ActionContext['alertRuleStore'],
    });

    const step: ReActStep = {
      thought: '',
      action: 'alert_rule_write',
      args: { op: 'create', prompt: 'Alert when error rate > 5%' },
    };
    const observation = await runner.execute(step, ctx);

    // The handler ran (created the rule) and the folderUid was filled silently.
    expect(observation).not.toMatch(/missing required argument/);
    expect(created.length).toBe(1);
    expect(created[0]!.folderUid).toBe('general');
    expect(folderRepo!.list).toHaveBeenCalled();
  });

  it('returns a folder-list clarifying message when alert_rule_write op=create has multiple folders', async () => {
    const { runner } = makeRunner();
    const folderRepo = fakeFolderRepo([
      { uid: 'prod', title: 'Production', parentUid: null },
      { uid: 'staging', title: 'Staging', parentUid: null },
    ]);
    const ctx = makeFakeActionContext({ folderRepository: folderRepo });

    const step: ReActStep = {
      thought: '',
      action: 'alert_rule_write',
      args: { op: 'create', prompt: 'Alert when error rate > 5%' },
    };
    const observation = await runner.execute(step, ctx);

    expect(observation).toMatch(/requires "folderUid"/);
    expect(observation).toContain('Production');
    expect(observation).toContain('Staging');
  });
});
