/**
 * Unit tests for the Anthropic provider's native tool_use wiring.
 *
 * These stub global `fetch` to verify request body shape (system separation,
 * tools / tool_choice passthrough) and to verify response parsing for the
 * four shapes the Messages API can return:
 *   - text-only
 *   - tool_use only
 *   - mixed text + tool_use
 *   - parallel tool_use blocks
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AnthropicProvider } from '../anthropic.js';
import { ProviderError, type ToolDefinition } from '../../types.js';

type FetchArgs = [url: string, init?: RequestInit];

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
  });
}

function mockFetch(impl: (...args: FetchArgs) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function getRequestBody(spy: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = spy.mock.calls[0] as FetchArgs;
  const init = call[1];
  expect(typeof init?.body).toBe('string');
  return JSON.parse(init?.body as string) as Record<string, unknown>;
}

const queryTool: ToolDefinition = {
  name: 'metrics.query',
  description: 'Query a metrics source',
  input_schema: {
    type: 'object',
    properties: {
      sourceId: { type: 'string', description: 'data source id' },
      query: { type: 'string', description: 'PromQL or similar' },
    },
    required: ['sourceId', 'query'],
  },
};

const logsTool: ToolDefinition = {
  name: 'logs.search',
  description: 'Search logs',
  input_schema: {
    type: 'object',
    properties: { q: { type: 'string' } },
    required: ['q'],
  },
};

function makeProvider(): AnthropicProvider {
  return new AnthropicProvider({ apiKey: 'sk-ant-test' });
}

describe('AnthropicProvider — request body', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-22T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('omits tools / tool_choice when no tools provided', async () => {
    const spy = mockFetch(async () =>
      makeJsonResponse({
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 3, output_tokens: 1 },
        model: 'claude-3-5-sonnet-latest',
        stop_reason: 'end_turn',
      }),
    );

    const provider = makeProvider();
    await provider.complete([{ role: 'user', content: 'hello' }], {
      model: 'claude-3-5-sonnet-latest',
    });

    const body = getRequestBody(spy);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.model).toBe('claude-3-5-sonnet-latest');
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('includes tools array verbatim and defaults tool_choice off', async () => {
    const spy = mockFetch(async () =>
      makeJsonResponse({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 5, output_tokens: 1 },
        model: 'claude-3-5-sonnet-latest',
        stop_reason: 'end_turn',
      }),
    );

    const provider = makeProvider();
    await provider.complete([{ role: 'user', content: 'hi' }], {
      model: 'claude-3-5-sonnet-latest',
      tools: [queryTool],
    });

    const body = getRequestBody(spy);
    expect(body.tools).toEqual([queryTool]);
    // No toolChoice provided → omit (let Anthropic default)
    expect(body.tool_choice).toBeUndefined();
  });

  it("translates toolChoice 'auto' / 'any' / specific tool", async () => {
    let captured: Record<string, unknown> = {};
    mockFetch(async (_url, init) => {
      captured = JSON.parse(init?.body as string) as Record<string, unknown>;
      return makeJsonResponse({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'claude-3-5-sonnet-latest',
        stop_reason: 'end_turn',
      });
    });

    const provider = makeProvider();

    await provider.complete([{ role: 'user', content: 'hi' }], {
      model: 'claude-3-5-sonnet-latest',
      tools: [queryTool],
      toolChoice: 'auto',
    });
    expect(captured.tool_choice).toEqual({ type: 'auto' });

    await provider.complete([{ role: 'user', content: 'hi' }], {
      model: 'claude-3-5-sonnet-latest',
      tools: [queryTool],
      toolChoice: 'any',
    });
    expect(captured.tool_choice).toEqual({ type: 'any' });

    await provider.complete([{ role: 'user', content: 'hi' }], {
      model: 'claude-3-5-sonnet-latest',
      tools: [queryTool],
      toolChoice: { type: 'tool', name: 'metrics.query' },
    });
    expect(captured.tool_choice).toEqual({ type: 'tool', name: 'metrics.query' });
  });

  it('separates system messages from conversation', async () => {
    const spy = mockFetch(async () =>
      makeJsonResponse({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'claude-3-5-sonnet-latest',
        stop_reason: 'end_turn',
      }),
    );

    const provider = makeProvider();
    await provider.complete(
      [
        { role: 'system', content: 'You are helpful.' },
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hi' },
      ],
      { model: 'claude-3-5-sonnet-latest' },
    );

    const body = getRequestBody(spy);
    expect(body.system).toBe('You are helpful.\nBe brief.');
    expect(body.messages).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  // ── Wire-translation regression tests ──────────────────────────────
  // Bedrock validates request bodies strictly; any internal-only field
  // that leaks into the wire body becomes a 400. These tests pin the
  // chokepoint so future internal additions don't silently re-leak.

  it('strips tool_name from tool_result blocks (internal-only field)', async () => {
    const spy = mockFetch(async () =>
      makeJsonResponse({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
      }),
    );

    const provider = makeProvider();
    await provider.complete(
      [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'metrics.query', input: { q: 'up' } },
          ],
        },
        {
          role: 'user',
          content: [
            // tool_name is required by openobs's internal ContentBlock (used
            // by OpenAI/Gemini providers) but MUST NOT appear on the wire.
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              tool_name: 'metrics.query',
              content: '{"value": 1}',
            },
          ],
        },
      ],
      { model: 'claude-sonnet-4-5' },
    );

    const body = getRequestBody(spy);
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    const userBlocks = messages[1]?.content as Array<Record<string, unknown>>;
    expect(userBlocks[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: '{"value": 1}',
    });
    expect(userBlocks[0]).not.toHaveProperty('tool_name');
  });

  it('preserves is_error on tool_result when set', async () => {
    const spy = mockFetch(async () =>
      makeJsonResponse({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
      }),
    );

    const provider = makeProvider();
    await provider.complete(
      [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              tool_name: 'metrics.query',
              content: 'boom',
              is_error: true,
            },
          ],
        },
      ],
      { model: 'claude-sonnet-4-5' },
    );

    const body = getRequestBody(spy);
    const userBlocks = (body.messages as Array<{ content: unknown }>)[0]
      ?.content as Array<Record<string, unknown>>;
    expect(userBlocks[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: 'boom',
      is_error: true,
    });
  });

  it('omits temperature for Opus 4.7 (deprecated sampling)', async () => {
    const spy = mockFetch(async () =>
      makeJsonResponse({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'claude-opus-4-7',
        stop_reason: 'end_turn',
      }),
    );

    const provider = makeProvider();
    await provider.complete([{ role: 'user', content: 'hi' }], {
      model: 'claude-opus-4-7',
      temperature: 0.2,
    });

    const body = getRequestBody(spy);
    expect(body).not.toHaveProperty('temperature');
  });

  it('passes temperature through for older models that still accept it', async () => {
    const spy = mockFetch(async () =>
      makeJsonResponse({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'claude-3-5-sonnet-latest',
        stop_reason: 'end_turn',
      }),
    );

    const provider = makeProvider();
    await provider.complete([{ role: 'user', content: 'hi' }], {
      model: 'claude-3-5-sonnet-latest',
      temperature: 0.2,
    });

    const body = getRequestBody(spy);
    expect(body.temperature).toBe(0.2);
  });

  it('omits temperature for Bedrock cross-region Opus 4.7 inference profile id', async () => {
    // The user's actual Bedrock id; previous regex (`^claude-…`) failed to
    // match this and silently let temperature through, re-triggering the
    // 400 these capabilities exist to prevent.
    const spy = mockFetch(async () =>
      makeJsonResponse({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'us.anthropic.claude-opus-4-7-20250101-v1:0',
        stop_reason: 'end_turn',
      }),
    );

    const provider = makeProvider();
    await provider.complete([{ role: 'user', content: 'hi' }], {
      model: 'us.anthropic.claude-opus-4-7-20250101-v1:0',
      temperature: 0.2,
    });

    const body = getRequestBody(spy);
    expect(body).not.toHaveProperty('temperature');
  });

  it('omits temperature when thinking is enabled on a sampling-deprecated model', async () => {
    const spy = mockFetch(async () =>
      makeJsonResponse({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'claude-opus-4-7',
        stop_reason: 'end_turn',
      }),
    );

    const provider = makeProvider();
    await provider.complete([{ role: 'user', content: 'hi' }], {
      model: 'claude-opus-4-7',
      temperature: 0.2,
      thinking: { effort: 'low' },
    });

    const body = getRequestBody(spy);
    expect(body).not.toHaveProperty('temperature');
    expect(body.thinking).toMatchObject({ type: 'enabled' });
  });
});

describe('AnthropicProvider — response parsing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('text-only content → content="text", toolCalls=[]', async () => {
    mockFetch(async () =>
      makeJsonResponse({
        content: [{ type: 'text', text: 'Hello, world.' }],
        usage: { input_tokens: 4, output_tokens: 5 },
        model: 'claude-3-5-sonnet-latest',
        stop_reason: 'end_turn',
      }),
    );

    const provider = makeProvider();
    const res = await provider.complete([{ role: 'user', content: 'hi' }], {
      model: 'claude-3-5-sonnet-latest',
    });

    expect(res.content).toBe('Hello, world.');
    expect(res.toolCalls).toEqual([]);
    expect(res.usage).toEqual({ promptTokens: 4, completionTokens: 5, totalTokens: 9 });
    expect(res.model).toBe('claude-3-5-sonnet-latest');
  });

  it('tool_use-only content → content="", toolCalls=[{...}]', async () => {
    mockFetch(async () =>
      makeJsonResponse({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_01ABC',
            name: 'metrics.query',
            input: { sourceId: 'prom-prod', query: 'up' },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
        model: 'claude-3-5-sonnet-latest',
        stop_reason: 'tool_use',
      }),
    );

    const provider = makeProvider();
    const res = await provider.complete([{ role: 'user', content: 'check up' }], {
      model: 'claude-3-5-sonnet-latest',
      tools: [queryTool],
      toolChoice: 'any',
    });

    expect(res.content).toBe('');
    expect(res.toolCalls).toEqual([
      {
        id: 'toolu_01ABC',
        name: 'metrics.query',
        input: { sourceId: 'prom-prod', query: 'up' },
      },
    ]);
  });

  it('mixed text + tool_use → both populated', async () => {
    mockFetch(async () =>
      makeJsonResponse({
        content: [
          { type: 'text', text: 'Let me check the metrics...' },
          {
            type: 'tool_use',
            id: 'toolu_01XYZ',
            name: 'metrics.query',
            input: { sourceId: 'prom-prod', query: 'up' },
          },
        ],
        usage: { input_tokens: 12, output_tokens: 30 },
        model: 'claude-3-5-sonnet-latest',
        stop_reason: 'tool_use',
      }),
    );

    const provider = makeProvider();
    const res = await provider.complete([{ role: 'user', content: 'metrics?' }], {
      model: 'claude-3-5-sonnet-latest',
      tools: [queryTool],
    });

    expect(res.content).toBe('Let me check the metrics...');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]).toEqual({
      id: 'toolu_01XYZ',
      name: 'metrics.query',
      input: { sourceId: 'prom-prod', query: 'up' },
    });
  });

  it('multiple tool_use blocks (parallel tools) preserved in order', async () => {
    mockFetch(async () =>
      makeJsonResponse({
        content: [
          { type: 'text', text: 'Running both in parallel.' },
          {
            type: 'tool_use',
            id: 'toolu_A',
            name: 'metrics.query',
            input: { sourceId: 'prom', query: 'up' },
          },
          {
            type: 'tool_use',
            id: 'toolu_B',
            name: 'logs.search',
            input: { q: 'error' },
          },
        ],
        usage: { input_tokens: 20, output_tokens: 50 },
        model: 'claude-3-5-sonnet-latest',
        stop_reason: 'tool_use',
      }),
    );

    const provider = makeProvider();
    const res = await provider.complete([{ role: 'user', content: 'investigate' }], {
      model: 'claude-3-5-sonnet-latest',
      tools: [queryTool, logsTool],
    });

    expect(res.content).toBe('Running both in parallel.');
    expect(res.toolCalls).toEqual([
      { id: 'toolu_A', name: 'metrics.query', input: { sourceId: 'prom', query: 'up' } },
      { id: 'toolu_B', name: 'logs.search', input: { q: 'error' } },
    ]);
  });

  it('multiple text blocks are joined with newline', async () => {
    mockFetch(async () =>
      makeJsonResponse({
        content: [
          { type: 'text', text: 'First.' },
          { type: 'text', text: 'Second.' },
        ],
        usage: { input_tokens: 1, output_tokens: 2 },
        model: 'claude-3-5-sonnet-latest',
        stop_reason: 'end_turn',
      }),
    );

    const provider = makeProvider();
    const res = await provider.complete([{ role: 'user', content: 'hi' }], {
      model: 'claude-3-5-sonnet-latest',
    });

    expect(res.content).toBe('First.\nSecond.');
    expect(res.toolCalls).toEqual([]);
  });

  it('empty content array → empty content + empty toolCalls', async () => {
    mockFetch(async () =>
      makeJsonResponse({
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
        model: 'claude-3-5-sonnet-latest',
        stop_reason: 'end_turn',
      }),
    );

    const provider = makeProvider();
    const res = await provider.complete([{ role: 'user', content: 'hi' }], {
      model: 'claude-3-5-sonnet-latest',
    });

    expect(res.content).toBe('');
    expect(res.toolCalls).toEqual([]);
  });

  it('throws typed ProviderError on non-2xx response with API error text', async () => {
    mockFetch(async () =>
      new Response('overloaded', {
        status: 529,
        headers: new Headers({ 'content-type': 'text/plain' }),
      }),
    );

    const provider = makeProvider();
    await expect(
      provider.complete([{ role: 'user', content: 'hi' }], {
        model: 'claude-3-5-sonnet-latest',
      }),
    ).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'network',
      provider: 'anthropic',
      status: 529,
      upstreamBody: 'overloaded',
    });
    await expect(
      provider.complete([{ role: 'user', content: 'hi' }], {
        model: 'claude-3-5-sonnet-latest',
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});
