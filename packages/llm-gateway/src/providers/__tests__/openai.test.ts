import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { OpenAIProvider } from '../openai.js';
import type { ToolDefinition, CompletionMessage } from '../../types.js';

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

interface FetchMockOptions {
  response?: unknown;
  status?: number;
  statusText?: string;
}

function installFetchMock(opts: FetchMockOptions = {}): {
  capture: CapturedRequest[];
  restore: () => void;
} {
  const capture: CapturedRequest[] = [];
  const status = opts.status ?? 200;
  const ok = status >= 200 && status < 300;
  const responseBody = opts.response ?? defaultResponse('hi', null);

  const fetchMock = vi.fn(async (input: unknown, init?: { body?: string; headers?: Record<string, string> }) => {
    const url = typeof input === 'string' ? input : String(input);
    let parsed: Record<string, unknown> = {};
    if (init?.body) {
      try {
        parsed = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
    }
    capture.push({ url, body: parsed, headers: init?.headers ?? {} });
    return {
      ok,
      status,
      statusText: opts.statusText ?? 'OK',
      json: async () => responseBody,
      text: async () => (typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)),
    } as Response;
  });

  const original = globalThis.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = fetchMock;

  return {
    capture,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = original;
    },
  };
}

function defaultResponse(content: string | null, toolCalls: unknown): unknown {
  return {
    model: 'gpt-4o',
    choices: [
      {
        message: {
          role: 'assistant',
          content,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

const messages: CompletionMessage[] = [{ role: 'user', content: 'hello' }];

const metricsQueryTool: ToolDefinition = {
  name: 'metrics.query',
  description: 'Run a PromQL query against a metrics source.',
  input_schema: {
    type: 'object',
    properties: {
      sourceId: { type: 'string', description: 'Datasource id' },
      query: { type: 'string', description: 'PromQL expression' },
    },
    required: ['sourceId', 'query'],
  },
};

const dashboardAddPanelsTool: ToolDefinition = {
  name: 'dashboard.add_panels',
  description: 'Append panels to an existing dashboard.',
  input_schema: {
    type: 'object',
    properties: {
      dashboardId: { type: 'string' },
    },
    required: ['dashboardId'],
  },
};

describe('OpenAIProvider — request translation', () => {
  let restore: () => void;

  afterEach(() => {
    restore?.();
  });

  it('translates dotted tool names to underscore-pair and forwards parameters', async () => {
    const m = installFetchMock();
    restore = m.restore;
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });

    await provider.complete(messages, {
      model: 'gpt-4o',
      tools: [metricsQueryTool, dashboardAddPanelsTool],
      toolChoice: 'auto',
    });

    expect(m.capture).toHaveLength(1);
    const body = m.capture[0]!.body as {
      tools: Array<{
        type: string;
        function: { name: string; description: string; parameters: unknown };
      }>;
      tool_choice: unknown;
    };
    expect(body.tools).toHaveLength(2);
    expect(body.tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'metrics__query',
        description: metricsQueryTool.description,
        parameters: metricsQueryTool.input_schema,
      },
    });
    expect(body.tools[1]!.function.name).toBe('dashboard__add_panels');
    expect(body.tools[1]!.function.parameters).toEqual(dashboardAddPanelsTool.input_schema);
    expect(body.tool_choice).toBe('auto');
  });

  it('omits tools/tool_choice when not requested', async () => {
    const m = installFetchMock();
    restore = m.restore;
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });

    await provider.complete(messages, { model: 'gpt-4o' });

    const body = m.capture[0]!.body;
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('maps tool_choice variants', async () => {
    // 'any' -> 'required'
    {
      const m = installFetchMock();
      restore = m.restore;
      const provider = new OpenAIProvider({ apiKey: 'sk-test' });
      await provider.complete(messages, {
        model: 'gpt-4o',
        tools: [metricsQueryTool],
        toolChoice: 'any',
      });
      expect(m.capture[0]!.body.tool_choice).toBe('required');
      restore();
    }

    // forced tool with dot in canonical name
    {
      const m = installFetchMock();
      restore = m.restore;
      const provider = new OpenAIProvider({ apiKey: 'sk-test' });
      await provider.complete(messages, {
        model: 'gpt-4o',
        tools: [metricsQueryTool],
        toolChoice: { type: 'tool', name: 'metrics.query' },
      });
      expect(m.capture[0]!.body.tool_choice).toEqual({
        type: 'function',
        function: { name: 'metrics__query' },
      });
      restore();
    }

    // 'auto' -> 'auto'
    {
      const m = installFetchMock();
      restore = m.restore;
      const provider = new OpenAIProvider({ apiKey: 'sk-test' });
      await provider.complete(messages, {
        model: 'gpt-4o',
        tools: [metricsQueryTool],
        toolChoice: 'auto',
      });
      expect(m.capture[0]!.body.tool_choice).toBe('auto');
    }
  });

  it('forwards model, temperature, max_tokens, messages, and Authorization header', async () => {
    const m = installFetchMock();
    restore = m.restore;
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });

    await provider.complete(messages, {
      model: 'gpt-4o',
      temperature: 0.3,
      maxTokens: 256,
    });

    const req = m.capture[0]!;
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(req.headers.Authorization).toBe('Bearer sk-test');
    expect(req.body.model).toBe('gpt-4o');
    expect(req.body.temperature).toBe(0.3);
    expect(req.body.max_tokens).toBe(256);
    expect(req.body.messages).toEqual(messages);
  });
});

describe('OpenAIProvider — response parsing', () => {
  let restore: () => void;

  afterEach(() => {
    restore?.();
  });

  it('text-only response: content set, toolCalls empty', async () => {
    const m = installFetchMock({
      response: defaultResponse('Hello there.', null),
    });
    restore = m.restore;
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });

    const result = await provider.complete(messages, { model: 'gpt-4o' });
    expect(result.content).toBe('Hello there.');
    expect(result.toolCalls).toEqual([]);
    expect(result.usage.totalTokens).toBe(15);
    expect(result.model).toBe('gpt-4o');
  });

  it('tool-only response: content empty string, toolCalls populated and dotted name restored', async () => {
    const m = installFetchMock({
      response: defaultResponse(null, [
        {
          id: 'call_abc123',
          type: 'function',
          function: {
            name: 'metrics__query',
            arguments: JSON.stringify({ sourceId: 'prom', query: 'up' }),
          },
        },
      ]),
    });
    restore = m.restore;
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });

    const result = await provider.complete(messages, { model: 'gpt-4o' });
    expect(result.content).toBe('');
    expect(result.toolCalls).toEqual([
      {
        id: 'call_abc123',
        name: 'metrics.query',
        input: { sourceId: 'prom', query: 'up' },
      },
    ]);
  });

  it('mixed text + tool_calls: both populated', async () => {
    const m = installFetchMock({
      response: defaultResponse('Let me check that for you.', [
        {
          id: 'call_xyz',
          type: 'function',
          function: {
            name: 'dashboard__add_panels',
            arguments: JSON.stringify({ dashboardId: 'd1' }),
          },
        },
        {
          id: 'call_xyz2',
          type: 'function',
          function: {
            name: 'metrics__query',
            arguments: JSON.stringify({ sourceId: 'p', query: 'rate(x[1m])' }),
          },
        },
      ]),
    });
    restore = m.restore;
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });

    const result = await provider.complete(messages, { model: 'gpt-4o' });
    expect(result.content).toBe('Let me check that for you.');
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]!.name).toBe('dashboard.add_panels');
    expect(result.toolCalls[0]!.input).toEqual({ dashboardId: 'd1' });
    expect(result.toolCalls[1]!.name).toBe('metrics.query');
    expect(result.toolCalls[1]!.input).toEqual({
      sourceId: 'p',
      query: 'rate(x[1m])',
    });
  });

  it('tags malformed arguments JSON with _malformed_args so the agent loop can detect it', async () => {
    const m = installFetchMock({
      response: defaultResponse(null, [
        {
          id: 'call_bad',
          type: 'function',
          function: {
            name: 'metrics__query',
            arguments: '{not valid json',
          },
        },
      ]),
    });
    restore = m.restore;
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });

    const result = await provider.complete(messages, { model: 'gpt-4o' });
    expect(result.toolCalls).toEqual([
      {
        id: 'call_bad',
        name: 'metrics.query',
        input: { _malformed_args: '{not valid json' },
      },
    ]);
  });

  it('tags non-object arguments JSON (e.g. array) with _malformed_args', async () => {
    const m = installFetchMock({
      response: defaultResponse(null, [
        {
          id: 'call_arr',
          type: 'function',
          function: {
            name: 'metrics__query',
            arguments: '[1,2,3]',
          },
        },
      ]),
    });
    restore = m.restore;
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });

    const result = await provider.complete(messages, { model: 'gpt-4o' });
    expect(result.toolCalls[0]!.input).toEqual({ _malformed_args: '[1,2,3]' });
  });

  it('handles empty arguments string as empty object', async () => {
    const m = installFetchMock({
      response: defaultResponse(null, [
        {
          id: 'call_empty',
          type: 'function',
          function: {
            name: 'metrics__query',
            arguments: '',
          },
        },
      ]),
    });
    restore = m.restore;
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });

    const result = await provider.complete(messages, { model: 'gpt-4o' });
    expect(result.toolCalls[0]!.input).toEqual({});
  });

  it('preserves reasoning_content on tool calls for replay', async () => {
    const m = installFetchMock({
      response: {
        model: 'deepseek-reasoner',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Let me check.',
              reasoning_content: 'Need metrics before creating panels.',
              tool_calls: [
                {
                  id: 'call_reasoning',
                  type: 'function',
                  function: {
                    name: 'metrics__query',
                    arguments: JSON.stringify({
                      sourceId: 'prom',
                      query: 'up',
                    }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    });
    restore = m.restore;
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });

    const result = await provider.complete(messages, {
      model: 'deepseek-reasoner',
    });
    expect(result.thinkingBlocks).toEqual(['Need metrics before creating panels.']);
    expect(result.toolCalls[0]!.providerMetadata).toEqual({
      reasoningContent: 'Need metrics before creating panels.',
    });
  });

  it('throws on non-2xx', async () => {
    const m = installFetchMock({
      status: 500,
      statusText: 'Internal Server Error',
      response: 'boom',
    });
    restore = m.restore;
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });

    await expect(provider.complete(messages, { model: 'gpt-4o' })).rejects.toThrow(/OpenAI API error 500/);
  });
});

describe('OpenAIProvider — name normalization round-trip', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('preserves single underscores in canonical names (only dots are encoded)', async () => {
    const m = installFetchMock({
      response: defaultResponse(null, [
        {
          id: 'call_1',
          type: 'function',
          // canonical name `dashboard.add_panels` -> wire `dashboard__add_panels`.
          // The intermediate single `_` in `add_panels` must NOT be touched.
          function: { name: 'dashboard__add_panels', arguments: '{}' },
        },
      ]),
    });
    restore = m.restore;
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });

    await provider.complete(messages, {
      model: 'gpt-4o',
      tools: [dashboardAddPanelsTool],
    });

    const sentName = (
      m.capture[0]!.body as {
        tools: Array<{ function: { name: string } }>;
      }
    ).tools[0]!.function.name;
    expect(sentName).toBe('dashboard__add_panels');

    // and reverse keeps the inner underscore
    const result = await new OpenAIProvider({ apiKey: 'sk-test' }).complete(messages, {
      model: 'gpt-4o',
    });
    expect(result.toolCalls[0]!.name).toBe('dashboard.add_panels');
  });
});

describe('OpenAIProvider — tool_result wiring', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('emits role:tool messages with tool_call_id and normalized name from tool_name', async () => {
    const m = installFetchMock();
    restore = m.restore;
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });

    await provider.complete(
      [
        { role: 'user', content: 'check' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_abc',
              name: 'metrics.query',
              input: { sourceId: 'prom', query: 'up' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_abc',
              tool_name: 'metrics.query',
              content: '1 1 1',
            },
          ],
        },
      ],
      { model: 'gpt-4o' },
    );

    const sent = m.capture[0]!.body as {
      messages: Array<{
        role: string;
        tool_call_id?: string;
        name?: string;
        content?: string | null;
      }>;
    };
    const toolMsg = sent.messages.find((mm) => mm.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool_call_id).toBe('call_abc');
    // dotted canonical name is encoded with the double-underscore wire form.
    expect(toolMsg!.name).toBe('metrics__query');
    expect(toolMsg!.content).toBe('1 1 1');
  });

  it('replays reasoning_content on assistant messages with tool calls', async () => {
    const m = installFetchMock();
    restore = m.restore;
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });

    await provider.complete(
      [
        { role: 'user', content: 'check' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_abc',
              name: 'metrics.query',
              input: { sourceId: 'prom', query: 'up' },
              providerMetadata: {
                reasoningContent: 'Need to query Prometheus first.',
              },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_abc',
              tool_name: 'metrics.query',
              content: '1 1 1',
            },
          ],
        },
      ],
      { model: 'deepseek-reasoner' },
    );

    const sent = m.capture[0]!.body as {
      messages: Array<{ role: string; reasoning_content?: string }>;
    };
    const assistantMsg = sent.messages.find((mm) => mm.role === 'assistant');
    expect(assistantMsg!.reasoning_content).toBe('Need to query Prometheus first.');
  });
});

describe('OpenAIProvider — config', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('uses configured baseUrl', async () => {
    const m = installFetchMock();
    restore = m.restore;
    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://example.test/openai',
    });
    await provider.complete(messages, { model: 'gpt-4o' });
    expect(m.capture[0]!.url).toBe('https://example.test/openai/chat/completions');
  });
});

describe('OpenAIProvider — listModels', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('keeps every model id returned by OpenAI-compatible endpoints', async () => {
    const m = installFetchMock({
      response: {
        data: [
          { id: 'deepseek-reasoner', owned_by: 'deepseek' },
          { id: 'claude-sonnet-4-5', owned_by: 'gateway' },
          { id: 'qwen3-coder', owned_by: 'gateway' },
          { id: 'deepseek-chat', owned_by: 'deepseek' },
        ],
      },
    });
    restore = m.restore;
    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com/v1',
    });

    await expect(provider.listModels()).resolves.toEqual([
      { id: 'claude-sonnet-4-5', name: 'claude-sonnet-4-5', provider: 'openai' },
      { id: 'deepseek-chat', name: 'deepseek-chat', provider: 'openai' },
      { id: 'deepseek-reasoner', name: 'deepseek-reasoner', provider: 'openai' },
      { id: 'qwen3-coder', name: 'qwen3-coder', provider: 'openai' },
    ]);
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});
