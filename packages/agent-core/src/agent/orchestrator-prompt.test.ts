/**
 * Prompt tests.
 *
 * These assertions guard the D0/D8/D15 principles: identity is factual, the
 * denial principle is present, and NO behavioral priming phrases leak in.
 */

import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from './orchestrator-prompt.js';
import { makeTestIdentity } from './test-helpers.js';

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
