import { describe, it, expect } from 'vitest';
import { applyEgressPolicy, webSearchDisabled, EGRESS_TOOLS } from './egress-policy.js';
import { agentRegistry } from './agent-registry.js';

describe('webSearchDisabled', () => {
  it('is off unless an operator turns it on', () => {
    // The default has to stay as it was; a silent behaviour change on upgrade
    // would be its own kind of dishonesty.
    expect(webSearchDisabled({})).toBe(false);
    expect(webSearchDisabled({ ROUNDS_DISABLE_WEB_SEARCH: '' })).toBe(false);
    expect(webSearchDisabled({ ROUNDS_DISABLE_WEB_SEARCH: 'false' })).toBe(false);
  });

  it('accepts the spellings an operator would actually type', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' true ']) {
      expect(webSearchDisabled({ ROUNDS_DISABLE_WEB_SEARCH: v }), v).toBe(true);
    }
  });
});

describe('applyEgressPolicy', () => {
  const tools = agentRegistry.get('orchestrator')!.allowedTools;

  it('leaves the tool set alone by default', () => {
    expect(applyEgressPolicy(tools, false)).toEqual([...tools]);
  });

  it('removes the outbound tool when disabled', () => {
    const filtered = applyEgressPolicy(tools, true);
    expect(filtered).not.toContain('web_search');
    // Everything else survives — this is an egress switch, not a lobotomy.
    expect(filtered.length).toBe(tools.length - 1);
    expect(filtered).toContain('metrics_query');
    expect(filtered).toContain('kb_search');
  });

  it('takes the tool out of the ceiling rather than failing at call time', () => {
    // Advertising a capability the operator has switched off costs the agent a
    // turn to discover, and tells the model something untrue in the meantime.
    expect(applyEgressPolicy(['web_search'], true)).toEqual([]);
  });

  it('names a tool that actually exists', () => {
    // A typo here would silently disable nothing.
    for (const tool of EGRESS_TOOLS) {
      expect(tools, tool).toContain(tool);
    }
  });
});
