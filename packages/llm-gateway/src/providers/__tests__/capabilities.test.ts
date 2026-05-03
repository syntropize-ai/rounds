/**
 * Capability detection — focuses on the model-id normalization that lets
 * Bedrock / Vertex / ARN-wrapped ids collapse to the same answer as the bare
 * first-party id. The previous regex-only implementation only matched
 * `^claude-…` and silently fell back to "old model behavior" for every
 * Bedrock cross-region inference profile, re-introducing the
 * `temperature is deprecated` 400 these capabilities exist to prevent.
 */

import { describe, it, expect } from 'vitest';
import { getCapabilities } from '../capabilities.js';

describe('getCapabilities — Anthropic sampling gating', () => {
  it.each([
    // First-party
    'claude-opus-4-7',
    'claude-opus-4-7-20250101',
    // Vertex AI version syntax
    'claude-opus-4-7@20250101',
    // Bedrock foundation model
    'anthropic.claude-opus-4-7-v1:0',
    // Bedrock cross-region inference profiles
    'us.anthropic.claude-opus-4-7-20250101-v1:0',
    'eu.anthropic.claude-opus-4-7-v1:0',
    'apac.anthropic.claude-opus-4-7-v1:0',
    'global.anthropic.claude-opus-4-7-v1:0',
    // Bedrock ARN
    'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-7-v1:0',
    // Casing should not matter
    'US.Anthropic.Claude-Opus-4-7-v1:0',
  ])('drops sampling for Opus 4.7 across id form: %s', (model) => {
    const caps = getCapabilities('anthropic', model);
    expect(caps.samplingParams.size).toBe(0);
  });

  it.each([
    'claude-sonnet-4-5',
    'claude-3-5-sonnet-latest',
    'claude-3-5-haiku-20241022',
    'anthropic.claude-3-5-sonnet-20241022-v2:0',
    'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  ])('keeps sampling for older models: %s', (model) => {
    const caps = getCapabilities('anthropic', model);
    expect(caps.samplingParams.has('temperature')).toBe(true);
  });

  it.each([
    'claude-sonnet-4-7',
    'claude-haiku-4-8',
    'claude-opus-5-0',
    'us.anthropic.claude-sonnet-5-1-v1:0',
  ])('drops sampling for future 4.7+/5.x ids: %s', (model) => {
    const caps = getCapabilities('anthropic', model);
    expect(caps.samplingParams.size).toBe(0);
  });
});

describe('getCapabilities — Anthropic thinking gating', () => {
  it.each([
    'claude-opus-4-7',
    'us.anthropic.claude-opus-4-7-v1:0',
    'arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-opus-4-7-v1:0',
    'claude-3-7-sonnet-20250219',
    'anthropic.claude-3-7-sonnet-20250219-v1:0',
  ])('reports thinking support across id forms: %s', (model) => {
    expect(getCapabilities('anthropic', model).supportsThinking).toBe(true);
  });

  it.each([
    'claude-3-5-sonnet-latest',
    'anthropic.claude-3-5-sonnet-20241022-v2:0',
  ])('reports no thinking for pre-3.7 models: %s', (model) => {
    expect(getCapabilities('anthropic', model).supportsThinking).toBe(false);
  });
});
