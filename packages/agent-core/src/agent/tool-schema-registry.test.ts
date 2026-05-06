import { describe, it, expect } from 'vitest';
import { TOOL_REGISTRY } from './tool-schema-registry.js';

describe('tool-schema-registry', () => {
  // Provider compatibility: OpenAI / Anthropic / Gemini / DeepSeek / Mistral
  // all accept ^[a-zA-Z0-9_-]{1,64}$ for tool names; Gemini specifically rejects
  // both `.` and `-`. We standardize on underscores so a single canonical name
  // works for every provider without per-provider escaping.
  const VALID = /^[a-zA-Z0-9_]{1,64}$/;

  it('every tool name uses only [a-zA-Z0-9_] and is <= 64 chars', () => {
    const offenders = Object.keys(TOOL_REGISTRY).filter((name) => !VALID.test(name));
    expect(offenders).toEqual([]);
  });

  it('the schema.name field matches its registry key for every entry', () => {
    const mismatches = Object.entries(TOOL_REGISTRY)
      .filter(([key, entry]) => entry.schema.name !== key)
      .map(([key, entry]) => `${key} != ${entry.schema.name}`);
    expect(mismatches).toEqual([]);
  });

  it('remediation_plan_create description carries the LOW COST / DEFAULT / Skip framing', () => {
    const desc = TOOL_REGISTRY['remediation_plan_create']?.schema.description ?? '';
    expect(desc).toContain('LOW COST');
    expect(desc).toContain('DEFAULT next step after investigation_complete');
    expect(desc).toContain('Skip ONLY when');
  });

  // The eight high-stakes tools used to carry an `extendedPrompt` field
  // emitted into a separate "# Tool Behaviors" prompt section. That field
  // is gone — the guidance now lives in schema.description so it rides the
  // native tool_use protocol adjacent to the tool definition.
  // These assertions guard against accidental drop of the inlined content.
  const INLINED_GUIDANCE: { tool: string; mustContain: string[] }[] = [
    { tool: 'ops_run_command', mustContain: ['intent="read"', 'intent="propose"', 'intent="execute_approved"'] },
    { tool: 'remediation_plan_create_rescue', mustContain: ['Pair with the primary plan ONLY', 'silence beats fabrication'] },
    { tool: 'dashboard_add_panels', mustContain: ['PRE-FLIGHT', 'web_search FIRST', 'training-data priors'] },
    { tool: 'investigation_create', mustContain: ['Trigger on diagnostic intents', 'BEFORE running discovery queries'] },
    { tool: 'investigation_add_section', mustContain: ['Interleave querying and writing', 'short `## heading`'] },
    { tool: 'investigation_complete', mustContain: ['LAST tool call', 'every section is discarded'] },
    { tool: 'web_search', mustContain: ['Cheap read', 'Named-system dashboard', 'unfamiliar metric'] },
  ];
  for (const { tool, mustContain } of INLINED_GUIDANCE) {
    it(`${tool} description retains its inlined behavior guidance`, () => {
      const desc = TOOL_REGISTRY[tool]?.schema.description ?? '';
      for (const phrase of mustContain) {
        expect(desc, `${tool}: missing "${phrase}"`).toContain(phrase);
      }
    });
  }

  it('no entry carries the removed extendedPrompt field (drift guard)', () => {
    const offenders = Object.entries(TOOL_REGISTRY)
      .filter(([, entry]) => 'extendedPrompt' in entry)
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});
