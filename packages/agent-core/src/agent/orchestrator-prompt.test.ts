/**
 * Prompt tests.
 *
 * These assertions guard the D0/D8/D15 principles: identity is factual, the
 * denial principle is present, and NO behavioral priming phrases leak in.
 */

import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, getTaskModule, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './orchestrator-prompt.js';
import { makeTestIdentity } from './test-helpers.js';
import type { Dashboard, DashboardMessage } from '@agentic-obs/common';

function build(identityOpts: Parameters<typeof makeTestIdentity>[0] = {}) {
  return buildSystemPrompt(null, [], [], null, [], {
    hasPrometheus: false,
    identity: makeTestIdentity(identityOpts),
    userDisplay: { name: 'Alice Example', login: 'alice', orgName: 'Platform' },
    now: '2026-04-18T00:00:00.000Z',
  });
}

describe('buildSystemPrompt — D8 identity + denial principle', () => {
  it('includes identity facts with the user display name, login, role, and org', () => {
    const prompt = build({ orgRole: 'Viewer' });
    expect(prompt).toContain('Alice Example');
    expect(prompt).toContain('(alice)');
    expect(prompt).toContain('org role Viewer in Platform');
    expect(prompt).toContain('2026-04-18T00:00:00.000Z');
  });

  it('contains the permission-denial principle verbatim', () => {
    const prompt = build({ orgRole: 'Viewer' });
    expect(prompt).toContain('permission denied:');
    expect(prompt).toContain('surface what you have already learned');
    expect(prompt).toContain('Do not retry denied calls');
    expect(prompt).toContain('Do not fabricate results');
  });

  it('includes escalation contact when provided', () => {
    const prompt = buildSystemPrompt(null, [], [], null, [], {
      hasPrometheus: false,
      identity: makeTestIdentity(),
      userDisplay: { name: 'Alice', orgName: 'Platform' },
      now: '2026-04-18T00:00:00.000Z',
      permissionEscalationContact: '#obs-support on Slack',
    });
    expect(prompt).toContain('Permission escalation contact: #obs-support on Slack');
  });

  it('omits the escalation-contact line when env is not set', () => {
    const prompt = build();
    expect(prompt).not.toContain('Permission escalation contact');
  });

  it('includes current page context as a prompt hint', () => {
    const prompt = buildSystemPrompt(null, [], [], null, [], {
      hasPrometheus: false,
      identity: makeTestIdentity(),
      now: '2026-04-18T00:00:00.000Z',
      pageContext: { kind: 'plan', id: 'plan_123' },
    });
    expect(prompt).toContain('# Current Page');
    expect(prompt).toContain('currently viewing the plan page');
    expect(prompt).toContain('Context ID: plan_123');
    expect(prompt).toContain('Do not narrow tool permissions from this hint.');
  });
});

describe('buildSystemPrompt — D0/D15 no behavioral priming', () => {
  const prompt = build({ orgRole: 'Viewer' });

  // The D0 guard: these phrases would prime the LLM to self-censor based on
  // role rather than reasoning normally against the gate. Failing this test
  // means someone landed a case-list style prompt.
  //
  // Note: 'If the user asks' was removed from the banned list when the
  // role-hint nudge (T6.C) landed. The viewer nudge uses that phrasing
  // verbatim as part of a single-sentence UX hint; it is not a case-list.
  for (const banned of [
    'be careful',
    "don't attempt",
    'do not attempt',
    'only try',
    'limited permissions',
    'As a Viewer',
    'as a viewer',
  ]) {
    it(`does not contain priming phrase: "${banned}"`, () => {
      expect(prompt).not.toContain(banned);
    });
  }
});

describe('buildSystemPrompt — identity section is suppressed without identity', () => {
  it('omits the entire identity block when identity is not provided', () => {
    const prompt = buildSystemPrompt(null, [], [], null, [], {
      hasPrometheus: false,
      now: '2026-04-18T00:00:00.000Z',
    });
    expect(prompt).not.toContain('You are acting on behalf of');
  });
});

describe('buildSystemPrompt — Ops connector guidance', () => {
  it('states that cluster queries require a configured connector and writes use runtime confirmation', () => {
    const prompt = build();
    expect(prompt).toContain('cluster/Kubernetes questions require a configured Ops connector');
    expect(prompt).toContain('do not invent a cluster');
    expect(prompt).toContain('intent="read"');
    expect(prompt).toContain('runtime permission + confirmation path');
    expect(prompt).not.toContain('approval/proposal');
  });

  it('shows not connected when no Ops connectors are configured', () => {
    const prompt = build();
    expect(prompt).toContain('# Ops Integrations\nnot connected');
  });

  it('lists configured Ops connectors when provided', () => {
    const prompt = buildSystemPrompt(null, [], [], null, [], {
      hasPrometheus: false,
      now: '2026-04-18T00:00:00.000Z',
      opsConnectors: [{
        id: 'kube-prod',
        name: 'Production Kubernetes',
        environment: 'prod',
        namespaces: ['default', 'api'],
        capabilities: ['read', 'propose'],
      }],
    });
    expect(prompt).toContain('connectorId="kube-prod"');
    expect(prompt).toContain('namespaces=default,api');
    expect(prompt).toContain('capabilities=read,propose');
  });
});

describe('buildSystemPrompt — investigation fix quality', () => {
  it('tells investigations to prefer durable fixes over current runtime values', () => {
    const module = getTaskModule('investigate');
    expect(module).toContain('Fix quality: durable over current-value patches');
    expect(module).toContain('temporary mitigation');
    expect(module).toContain('ephemeral runtime value');
    expect(module).toContain('stable control point');
    expect(module).toContain('primary remediation');
  });
});

describe('buildSystemPrompt — T6.C role-conditional nudge', () => {
  const VIEWER_LINE = 'You are operating as a Viewer.';
  const EDITOR_LINE = 'You are operating as an Editor.';

  it('appends the Viewer nudge when orgRole is Viewer', () => {
    const prompt = build({ orgRole: 'Viewer' });
    expect(prompt).toContain(VIEWER_LINE);
    // Rephrased away from the D0-adjacent "do not propose or attempt mutations".
    // Anchor on the gate-centric framing instead.
    expect(prompt).toContain('the RBAC gate rejects any mutation request');
    expect(prompt).not.toContain(EDITOR_LINE);
  });

  it('appends the Editor nudge when orgRole is Editor', () => {
    const prompt = build({ orgRole: 'Editor' });
    expect(prompt).toContain(EDITOR_LINE);
    // Same reframing: the gate does the blocking, the agent doesn't self-censor.
    expect(prompt).toContain('the gate will reject them');
    expect(prompt).not.toContain(VIEWER_LINE);
  });

  it('appends neither nudge for Admin role (default)', () => {
    const prompt = build({ orgRole: 'Admin' });
    expect(prompt).not.toContain(VIEWER_LINE);
    expect(prompt).not.toContain(EDITOR_LINE);
  });
});

describe('buildSystemPrompt — actions framing + cache boundary', () => {
  function makeDashboard(): Dashboard {
    return {
      id: 'dash-1',
      type: 'metrics',
      title: 'HTTP Monitoring',
      description: '',
      prompt: '',
      userId: 'u-1',
      status: 'ready',
      panels: [],
      variables: [],
      refreshIntervalSec: 30,
      datasourceIds: [],
      useExistingMetrics: true,
      createdAt: '2026-04-18T00:00:00.000Z',
      updatedAt: '2026-04-18T00:00:00.000Z',
    } as unknown as Dashboard;
  }

  it('emits the dynamic boundary exactly once in a static-only build', () => {
    const prompt = buildSystemPrompt(null, [], [], null, [], {
      hasPrometheus: false,
      now: '2026-04-18T00:00:00.000Z',
    });
    const occurrences = prompt.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY).length - 1;
    expect(occurrences).toBe(1);
  });

  it('places the boundary AFTER the actions section and BEFORE dynamic dashboard context', () => {
    const dashboard = makeDashboard();
    const history: DashboardMessage[] = [
      { role: 'user', content: 'hi' } as unknown as DashboardMessage,
    ];
    const prompt = buildSystemPrompt(dashboard, history, [], null, [], {
      hasPrometheus: false,
      now: '2026-04-18T00:00:00.000Z',
    });
    const actionsIdx = prompt.indexOf('# Executing actions with care');
    const boundaryIdx = prompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    const dashboardIdx = prompt.indexOf('# Current Dashboard Context');
    expect(actionsIdx).toBeGreaterThan(-1);
    expect(boundaryIdx).toBeGreaterThan(actionsIdx);
    expect(dashboardIdx).toBeGreaterThan(boundaryIdx);
  });

  it('omits remediation_plan_create framing for the foreground chat prompt', () => {
    const prompt = buildSystemPrompt(null, [], [], null, [], {
      hasPrometheus: false,
      now: '2026-04-18T00:00:00.000Z',
    });
    expect(prompt).toContain('# Executing actions with care');
    expect(prompt).toContain('Formal remediation plans are not available in interactive chat');
    expect(prompt).not.toContain('remediation_plan_create');
  });

  it('includes remediation_plan_create framing only when the background tool is allowed', () => {
    const prompt = buildSystemPrompt(null, [], [], null, [], {
      hasPrometheus: false,
      now: '2026-04-18T00:00:00.000Z',
      allowedTools: ['remediation_plan_create'],
    });
    expect(prompt).toContain('alert-triggered background remediation');
    expect(prompt).toContain('remediation_plan_create');
  });
});

describe('per-tool behavior guidance is now inlined into schema descriptions', () => {
  // The previous "# Tool Behaviors" section was removed; each high-stakes
  // tool now carries its own decision-time WHEN/WHEN-NOT/anti-pattern
  // guidance directly in schema.description, so the model sees it adjacent
  // to the tool definition rather than buried in the static prompt prefix.
  // The system prompt itself no longer renders the "# Tool Behaviors"
  // header — descriptions ride the native tool_use protocol.
  it('does NOT render a "# Tool Behaviors" header in the system prompt', () => {
    const prompt = buildSystemPrompt(null, [], [], null, [], {
      hasPrometheus: false,
      now: '2026-04-18T00:00:00.000Z',
    });
    expect(prompt).not.toContain('# Tool Behaviors');
  });
});

describe('buildSystemPrompt — alert history reflects current store', () => {
  it('does not surface deleted alert creations as current recoverable rules', () => {
    const history: DashboardMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        content: 'Created old alert.',
        timestamp: '2026-04-18T00:00:00.000Z',
        actions: [
          {
            type: 'create_alert_rule',
            ruleId: 'old_alert',
            name: 'Proxy Down',
            severity: 'high',
            query: 'envoy_server_live',
            operator: '==',
            threshold: 0,
            forDurationSec: 300,
            evaluationIntervalSec: 60,
          },
        ],
      },
      {
        id: 'm2',
        role: 'assistant',
        content: 'Deleted old alert.',
        timestamp: '2026-04-18T00:01:00.000Z',
        actions: [
          {
            type: 'delete_alert_rule',
            ruleId: 'old_alert',
            name: 'Proxy Down',
          },
        ],
      },
    ] as DashboardMessage[];

    const prompt = buildSystemPrompt(null, history, [], null, [], {
      hasPrometheus: false,
      now: '2026-04-18T00:02:00.000Z',
    });

    expect(prompt).not.toContain('Assistant created alert [old_alert]');
    expect(prompt).toContain('Assistant deleted alert [old_alert] "Proxy Down"');
    expect(prompt).toContain('deleted entries are not candidates to recreate');
  });

  it('keeps created alert history when the rule still exists', () => {
    const history: DashboardMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        content: 'Created current alert.',
        timestamp: '2026-04-18T00:00:00.000Z',
        actions: [
          {
            type: 'create_alert_rule',
            ruleId: 'current_alert',
            name: 'Proxy Memory Pressure',
            severity: 'medium',
            query: 'envoy_server_memory_allocated / envoy_server_memory_heap_size',
            operator: '>',
            threshold: 0.85,
            forDurationSec: 300,
            evaluationIntervalSec: 60,
          },
        ],
      },
    ] as DashboardMessage[];

    const prompt = buildSystemPrompt(
      null,
      history,
      [{
        id: 'current_alert',
        name: 'Proxy Memory Pressure',
        severity: 'medium',
        condition: {
          query: 'envoy_server_memory_allocated / envoy_server_memory_heap_size',
          operator: '>',
          threshold: 0.85,
        },
      }],
      null,
      [],
      {
        hasPrometheus: false,
        now: '2026-04-18T00:02:00.000Z',
      },
    );

    expect(prompt).toContain('Assistant created alert [current_alert]');
    expect(prompt).toContain('# Alert Rules');
    expect(prompt).toContain('Proxy Memory Pressure');
  });
});

describe('buildSystemPrompt — deferred tools listing', () => {
  it('omits the <deferred-tools> block when allowedTools is not provided', () => {
    const prompt = buildSystemPrompt(null, [], [], null, [], {
      hasPrometheus: false,
      now: '2026-04-18T00:00:00.000Z',
    });
    expect(prompt).not.toContain('<deferred-tools>');
  });

  it('emits a <deferred-tools> block listing cold-tier tools but NOT always-on tools', () => {
    // Mix of always-on (metrics_discover, web_search) and deferred (metrics_query, alert_rule_write).
    const prompt = buildSystemPrompt(null, [], [], null, [], {
      hasPrometheus: false,
      now: '2026-04-18T00:00:00.000Z',
      allowedTools: ['metrics_discover', 'web_search', 'metrics_query', 'alert_rule_write'],
    });
    expect(prompt).toContain('<deferred-tools>');
    expect(prompt).toContain('</deferred-tools>');
    // Deferred tools appear by name.
    expect(prompt).toContain('metrics_query:');
    expect(prompt).toContain('alert_rule_write:');
    // Always-on tools do NOT appear in the deferred listing — they already
    // ship as full schemas via the native tool_use channel.
    const block = prompt.slice(prompt.indexOf('<deferred-tools>'), prompt.indexOf('</deferred-tools>'));
    expect(block).not.toContain('metrics_discover:');
    expect(block).not.toContain('web_search:');
  });

  it('skips the block entirely when no deferred tools are in scope', () => {
    const prompt = buildSystemPrompt(null, [], [], null, [], {
      hasPrometheus: false,
      now: '2026-04-18T00:00:00.000Z',
      allowedTools: ['metrics_discover', 'web_search'],  // both always-on
    });
    expect(prompt).not.toContain('<deferred-tools>');
  });
});

describe('getDeferredToolsSection — budget enforcement', () => {
  it('respects the budget cap on the live registry surface', async () => {
    const { DEFERRED_TOOLS_LISTING_BUDGET, getDeferredToolsSection } = await import('./orchestrator-prompt.js');
    const { TOOL_REGISTRY } = await import('./tool-schema-registry.js');
    const allDeferred = Object.entries(TOOL_REGISTRY)
      .filter(([, e]) => e.category === 'deferred')
      .map(([name]) => name);
    const section = getDeferredToolsSection(allDeferred);
    expect(section.length).toBeLessThanOrEqual(DEFERRED_TOOLS_LISTING_BUDGET);
  });

  it('truncates alphabetically with a "+N more" footer when the listing overflows the budget', async () => {
    const { DEFERRED_TOOLS_LISTING_BUDGET, getDeferredToolsSection } = await import('./orchestrator-prompt.js');
    const { TOOL_REGISTRY } = await import('./tool-schema-registry.js');
    // Inject synthetic deferred entries so the listing definitively overflows.
    const created: string[] = [];
    try {
      for (let i = 0; i < 40; i++) {
        const name = `deferred_padding_tool_${String(i).padStart(3, '0')}`;
        TOOL_REGISTRY[name] = {
          category: 'deferred',
          schema: {
            name,
            description: 'Synthetic padding tool used by the truncation budget test only.',
            input_schema: { type: 'object', properties: {}, required: [] },
          },
        };
        created.push(name);
      }
      const section = getDeferredToolsSection(created);
      expect(section.length).toBeLessThanOrEqual(DEFERRED_TOOLS_LISTING_BUDGET);
      expect(section).toMatch(/\+\d+ more \(truncated to fit budget\)/);
      // Earliest alphabetical entries are kept; latest are dropped.
      expect(section).toContain('deferred_padding_tool_000:');
      expect(section).not.toContain('deferred_padding_tool_039:');
    }
    finally {
      for (const name of created) delete (TOOL_REGISTRY as Record<string, unknown>)[name];
    }
  });

  it('produces alphabetically-sorted listing so truncation is deterministic', async () => {
    const { getDeferredToolsSection } = await import('./orchestrator-prompt.js');
    const section = getDeferredToolsSection(['metrics_query', 'alert_rule_list', 'logs_query']);
    const aIdx = section.indexOf('alert_rule_list:');
    const lIdx = section.indexOf('logs_query:');
    const mIdx = section.indexOf('metrics_query:');
    expect(aIdx).toBeGreaterThan(-1);
    expect(lIdx).toBeGreaterThan(aIdx);
    expect(mIdx).toBeGreaterThan(lIdx);
  });
});
