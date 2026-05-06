/**
 * Prompt tests.
 *
 * These assertions guard the D0/D8/D15 principles: identity is factual, the
 * denial principle is present, and NO behavioral priming phrases leak in.
 */

import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './orchestrator-prompt.js';
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
  it('states that cluster queries require a configured connector and write commands propose approval', () => {
    const prompt = build();
    expect(prompt).toContain('cluster/Kubernetes questions require a configured Ops connector');
    expect(prompt).toContain('do not invent a cluster');
    expect(prompt).toContain('intent="read"');
    expect(prompt).toContain('intent="propose"');
    expect(prompt).toContain('approval/proposal');
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

  it('includes the actions section heading and remediation_plan_create framing', () => {
    const prompt = buildSystemPrompt(null, [], [], null, [], {
      hasPrometheus: false,
      now: '2026-04-18T00:00:00.000Z',
    });
    expect(prompt).toContain('# Executing actions with care');
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
