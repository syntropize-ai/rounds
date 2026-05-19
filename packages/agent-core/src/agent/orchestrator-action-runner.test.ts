/**
 * Tests for the schema-driven required-arg check in
 * PermissionWrappedActionRunner.execute. Covers the generic missing-arg path
 * and the alert_rule_write op=create default folder path.
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

const alertCreateSpec = {
  name: 'High latency',
  description: 'Alert when latency is high.',
  condition: { query: 'up', operator: '>', threshold: 1, forDurationSec: 60 },
  evaluationIntervalSec: 60,
  severity: 'high',
  labels: {},
};

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

  it('creates alert_rule_write op=create at root (folderUid=null) when no folder is requested and no dashboard is active', async () => {
    const { runner } = makeRunner();
    const created: Array<Record<string, unknown>> = [];
    const ctx = makeFakeActionContext({
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
      args: { op: 'create', spec: alertCreateSpec },
    };
    const observation = await runner.execute(step, ctx);

    expect(observation).not.toMatch(/missing required argument/);
    expect(created.length).toBe(1);
    // Grafana parity: no synthetic system folder. folderUid is null at root.
    expect(created[0]!.folderUid).toBeNull();
  });

  it('uses an explicitly requested folder for alert_rule_write op=create', async () => {
    const { runner } = makeRunner();
    const created: Array<Record<string, unknown>> = [];
    const ctx = makeFakeActionContext({
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
      args: { op: 'create', spec: alertCreateSpec, folderUid: 'prod' },
    };
    const observation = await runner.execute(step, ctx);

    expect(observation).not.toMatch(/missing required argument/);
    expect(created[0]!.folderUid).toBe('prod');
  });
});
