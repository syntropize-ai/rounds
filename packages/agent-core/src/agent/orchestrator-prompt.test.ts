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
  for (const banned of [
    'be careful',
    "don't attempt",
    'do not attempt',
    'If the user asks',
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
