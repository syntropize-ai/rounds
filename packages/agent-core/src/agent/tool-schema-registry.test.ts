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
});
