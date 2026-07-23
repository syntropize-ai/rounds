import { describe, it, expect } from 'vitest';
import { TOOL_REGISTRY } from './tool-schema-registry.js';
import { agentRegistry } from './agent-registry.js';
import { TOOL_PERMS, UNGATED_TOOLS } from './tool-permissions.js';

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

  it('remediation_plan_create description carries background-only framing', () => {
    const desc = TOOL_REGISTRY['remediation_plan_create']?.schema.description ?? '';
    const investigationId = TOOL_REGISTRY['remediation_plan_create']?.schema.input_schema.properties?.['investigationId'];
    expect(desc).toContain('LOW COST');
    expect(desc).toContain('BACKGROUND ONLY');
    expect(desc).toContain('background investigation completes');
    expect(desc).not.toContain('Direct user request');
    expect(desc).not.toContain('investigationId: ""');
    expect(desc).toContain('Skip ONLY when');
    expect(JSON.stringify(investigationId)).toContain('Required');
  });

  // The eight high-stakes tools used to carry an `extendedPrompt` field
  // emitted into a separate "# Tool Behaviors" prompt section. That field
  // is gone — the guidance now lives in schema.description so it rides the
  // native tool_use protocol adjacent to the tool definition.
  // These assertions guard against accidental drop of the inlined content.
  const INLINED_GUIDANCE: { tool: string; mustContain: string[] }[] = [
    { tool: 'ops_run_command', mustContain: ['intent="read"', 'intent="propose"', 'intent="execute_approved"'] },
    { tool: 'remediation_plan_create_rescue', mustContain: ['Pair with the primary plan ONLY', 'silence beats fabrication'] },
    { tool: 'dashboard_add_panels', mustContain: ['PRE-FLIGHT', 'kb_recommend FIRST', 'training-data priors'] },
    { tool: 'investigation_create', mustContain: ['Trigger on diagnostic intents', 'BEFORE running discovery queries'] },
    { tool: 'investigation_record_check', mustContain: ['diagnostic check', 'main loop keeps its investigation state'] },
    { tool: 'investigation_add_text', mustContain: ['Interleave', 'short `## heading`'] },
    { tool: 'investigation_add_evidence', mustContain: ['Reuse the query', 'auto-captured snapshot'] },
    { tool: 'investigation_complete', mustContain: ['LAST tool call', 'every section is discarded', '80% confidence', 'durable', 'ephemeral runtime value'] },
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

  it('remediation_plan_create_rescue requires the evidence-gate fields', () => {
    // The rescue handler runs the same evidence gate as the primary
    // (createPlanCommon → validateRemediationPlanEvidence), which rejects
    // plans without targetObject/validationMethod. The schema must demand
    // them or every schema-conformant rescue plan is rejected at runtime.
    const schema = TOOL_REGISTRY['remediation_plan_create_rescue']?.schema.input_schema;
    expect(schema?.properties?.['targetObject']).toBeDefined();
    expect(schema?.properties?.['validationMethod']).toBeDefined();
    expect(schema?.required).toContain('targetObject');
    expect(schema?.required).toContain('validationMethod');
  });

  it('no entry carries the removed extendedPrompt field (drift guard)', () => {
    const offenders = Object.entries(TOOL_REGISTRY)
      .filter(([, entry]) => 'extendedPrompt' in entry)
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it('investigation_complete nextAction asks for durable remediation, not only emergency workaround', () => {
    const nextAction = TOOL_REGISTRY['investigation_complete']?.schema.input_schema.properties?.['nextAction'];
    const description = JSON.stringify(nextAction);
    expect(description).toContain('Durable fix');
    expect(description).toContain('temporary mitigation');
    expect(description).toContain('durable remediation');
  });

  // ---------------------------------------------------------------------
  // End-to-end reachability invariants. Until these passed, several tools
  // (remediation_plan_create, folder_create/_list, ask_user) had a handler
  // wired but were silently absent from the model's tool surface because
  // they weren't listed in any agent's allowedTools. The invariants below
  // catch that drift at startup-time CI rather than at user-facing failure.
  // ---------------------------------------------------------------------
  it('every TOOL_REGISTRY tool is referenced by at least one agent allowedTools', () => {
    const referenced = new Set<string>();
    for (const def of agentRegistry.getAll()) {
      for (const tool of def.allowedTools) referenced.add(tool);
    }
    const orphans = Object.keys(TOOL_REGISTRY).filter((name) => !referenced.has(name));
    expect(orphans).toEqual([]);
  });

  it('every TOOL_PERMS entry is referenced by at least one agent allowedTools', () => {
    const referenced = new Set<string>();
    for (const def of agentRegistry.getAll()) {
      for (const tool of def.allowedTools) referenced.add(tool);
    }
    const orphans = Object.keys(TOOL_PERMS).filter((name) => !referenced.has(name));
    expect(orphans).toEqual([]);
  });

  it('every non-internal allowedTools entry has a TOOL_REGISTRY schema', () => {
    // NON_LLM_TOOLS in tool-schema-registry.ts are internal (llm.complete,
    // verifier.run) and intentionally have no schema. Everything else MUST.
    const INTERNAL = new Set<string>(['llm.complete', 'verifier.run']);
    const missing: { agent: string; tool: string }[] = [];
    for (const def of agentRegistry.getAll()) {
      for (const tool of def.allowedTools) {
        if (INTERNAL.has(tool)) continue;
        if (!TOOL_REGISTRY[tool]) missing.push({ agent: def.type, tool });
      }
    }
    expect(missing).toEqual([]);
  });

  it('every non-internal allowedTools entry is gated or ungated (no silent unknown_tool deny)', () => {
    const INTERNAL = new Set<string>(['llm.complete', 'verifier.run']);
    const ungated: { agent: string; tool: string }[] = [];
    for (const def of agentRegistry.getAll()) {
      for (const tool of def.allowedTools) {
        if (INTERNAL.has(tool)) continue;
        if (UNGATED_TOOLS.has(tool)) continue;
        if (TOOL_PERMS[tool]) continue;
        ungated.push({ agent: def.type, tool });
      }
    }
    expect(ungated).toEqual([]);
  });

  it('keeps remediation plans out of the foreground orchestrator tool surface', () => {
    const foreground = agentRegistry.get('orchestrator')!;
    const background = agentRegistry.get('background_orchestrator')!;
    expect(foreground.allowedTools).not.toContain('remediation_plan_create');
    expect(foreground.allowedTools).not.toContain('remediation_plan_create_rescue');
    expect(background.allowedTools).toContain('remediation_plan_create');
    expect(background.allowedTools).toContain('remediation_plan_create_rescue');
  });
});
