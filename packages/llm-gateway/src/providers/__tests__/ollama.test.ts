import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OllamaProvider } from '../ollama.js';
import { ProviderCapabilityError } from '../capabilities.js';
import { ProviderError, type CompletionMessage, type LLMOptions, type ToolDefinition } from '../../types.js';

// -- Mock fetch helpers --

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
interface FetchCall {
  url: string;
  init: FetchInit | undefined;
}

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeBadResponse(status: number, text = ''): Response {
  return new Response(text, { status });
}

function setupFetchQueue(responses: Response[]): { calls: FetchCall[] } {
  const queue = [...responses];
  const calls: FetchCall[] = [];
  globalThis.fetch = vi.fn(async (input: FetchInput, init?: FetchInit) => {
    calls.push({ url: typeof input === 'string' ? input : String(input), init });
    const next = queue.shift();
    if (!next) {
      throw new Error('fetch queue exhausted — test asked for more requests than queued');
    }
    return next;
  }) as unknown as typeof fetch;
  return { calls };
}

const TOOL_CAPABLE_SHOW = { capabilities: ['completion', 'tools'] };
const TOOL_INCAPABLE_SHOW = { capabilities: ['completion'] };

const SAMPLE_TOOLS: ToolDefinition[] = [
  {
    name: 'metrics.query',
    description: 'Query Prometheus metrics',
    input_schema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string' },
        query: { type: 'string' },
      },
      required: ['sourceId', 'query'],
    },
  },
];

const MESSAGES: CompletionMessage[] = [{ role: 'user', content: 'Check uptime' }];
const OPTS: LLMOptions = { model: 'llama3.1', temperature: 0.5, maxTokens: 256, tools: SAMPLE_TOOLS };

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// -- Capability probe --

describe('OllamaProvider capability probe', () => {
  it('succeeds when /api/show advertises tools capability', async () => {
    const { calls } = setupFetchQueue([
      makeResponse(TOOL_CAPABLE_SHOW),
      makeResponse({
        model: 'llama3.1',
        message: { role: 'assistant', content: 'ok' },
        prompt_eval_count: 5,
        eval_count: 7,
      }),
    ]);
    const provider = new OllamaProvider();
    const res = await provider.complete(MESSAGES, OPTS);
    expect(res.content).toBe('ok');
    expect(res.toolCalls).toEqual([]);
    expect(calls[0]!.url).toMatch(/\/api\/show$/);
    expect(calls[1]!.url).toMatch(/\/api\/chat$/);
  });

  it('throws ProviderCapabilityError when model lacks tools capability', async () => {
    setupFetchQueue([makeResponse(TOOL_INCAPABLE_SHOW)]);
    const provider = new OllamaProvider();
    await expect(provider.complete(MESSAGES, OPTS)).rejects.toBeInstanceOf(ProviderCapabilityError);
  });

  it('throws ProviderCapabilityError when /api/show returns 404', async () => {
    setupFetchQueue([makeBadResponse(404, 'not found')]);
    const provider = new OllamaProvider();
    await expect(provider.complete(MESSAGES, OPTS)).rejects.toBeInstanceOf(ProviderCapabilityError);
  });

  it('throws ProviderCapabilityError when /api/show response has no capabilities field', async () => {
    setupFetchQueue([makeResponse({ modelfile: '...', license: 'MIT' })]);
    const provider = new OllamaProvider();
    await expect(provider.complete(MESSAGES, OPTS)).rejects.toBeInstanceOf(ProviderCapabilityError);
  });

  it('caches the probe — second complete() does not re-query /api/show', async () => {
    const { calls } = setupFetchQueue([
      makeResponse(TOOL_CAPABLE_SHOW),
      makeResponse({
        model: 'llama3.1',
        message: { role: 'assistant', content: 'first' },
      }),
      makeResponse({
        model: 'llama3.1',
        message: { role: 'assistant', content: 'second' },
      }),
    ]);
    const provider = new OllamaProvider();
    await provider.complete(MESSAGES, OPTS);
    await provider.complete(MESSAGES, OPTS);

    const showCalls = calls.filter((c) => c.url.endsWith('/api/show'));
    expect(showCalls).toHaveLength(1);

    const chatCalls = calls.filter((c) => c.url.endsWith('/api/chat'));
    expect(chatCalls).toHaveLength(2);
  });

  it('does not cache failed probes — retries on next call', async () => {
    const { calls } = setupFetchQueue([
      makeBadResponse(404),
      makeResponse(TOOL_CAPABLE_SHOW),
      makeResponse({
        model: 'llama3.1',
        message: { role: 'assistant', content: 'recovered' },
      }),
    ]);
    const provider = new OllamaProvider();
    await expect(provider.complete(MESSAGES, OPTS)).rejects.toBeInstanceOf(ProviderCapabilityError);
    const res = await provider.complete(MESSAGES, OPTS);
    expect(res.content).toBe('recovered');

    const showCalls = calls.filter((c) => c.url.endsWith('/api/show'));
    expect(showCalls).toHaveLength(2);
  });
});

// -- Request shape --

describe('OllamaProvider request body', () => {
  it('sends tools in OpenAI shape with dot->_ name mapping and no JSON format', async () => {
    const { calls } = setupFetchQueue([
      makeResponse(TOOL_CAPABLE_SHOW),
      makeResponse({
        model: 'llama3.1',
        message: { role: 'assistant', content: 'done' },
      }),
    ]);
    const provider = new OllamaProvider();
    await provider.complete(MESSAGES, OPTS);

    const chatCall = calls.find((c) => c.url.endsWith('/api/chat'))!;
    const sentBody = JSON.parse(String(chatCall.init?.body)) as Record<string, unknown>;

    expect(sentBody.model).toBe('llama3.1');
    expect(sentBody.stream).toBe(false);
    expect(sentBody.format).toBeUndefined();
    expect(sentBody.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'metrics_query',
          description: 'Query Prometheus metrics',
          parameters: SAMPLE_TOOLS[0]!.input_schema,
        },
      },
    ]);
    expect(sentBody.options).toEqual({ temperature: 0.5, num_predict: 256 });
  });

  it('omits tools field when no tools provided', async () => {
    const { calls } = setupFetchQueue([
      makeResponse(TOOL_CAPABLE_SHOW),
      makeResponse({
        model: 'llama3.1',
        message: { role: 'assistant', content: 'hi' },
      }),
    ]);
    const provider = new OllamaProvider();
    await provider.complete(MESSAGES, { model: 'llama3.1' });

    const chatCall = calls.find((c) => c.url.endsWith('/api/chat'))!;
    const sentBody = JSON.parse(String(chatCall.init?.body)) as Record<string, unknown>;
    expect(sentBody.tools).toBeUndefined();
  });
});

// -- Response parsing --

describe('OllamaProvider response parsing', () => {
  it('parses text-only responses', async () => {
    setupFetchQueue([
      makeResponse(TOOL_CAPABLE_SHOW),
      makeResponse({
        model: 'llama3.1',
        message: { role: 'assistant', content: 'plain prose answer' },
        prompt_eval_count: 10,
        eval_count: 4,
      }),
    ]);
    const provider = new OllamaProvider();
    const res = await provider.complete(MESSAGES, OPTS);
    expect(res.content).toBe('plain prose answer');
    expect(res.toolCalls).toEqual([]);
    expect(res.usage).toEqual({ promptTokens: 10, completionTokens: 4, totalTokens: 14 });
  });

  it('parses tool_calls-only responses with synthesized ids and pre-parsed args', async () => {
    setupFetchQueue([
      makeResponse(TOOL_CAPABLE_SHOW),
      makeResponse({
        model: 'llama3.1',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              function: {
                name: 'metrics_query',
                arguments: { sourceId: 'prom', query: 'up' },
              },
            },
            {
              function: {
                name: 'logs_search',
                arguments: { source: 'loki', q: 'error' },
              },
            },
          ],
        },
      }),
    ]);
    const provider = new OllamaProvider();
    const res = await provider.complete(MESSAGES, OPTS);
    expect(res.content).toBe('');
    expect(res.toolCalls).toEqual([
      { id: 'ollama_call_0', name: 'metrics_query', input: { sourceId: 'prom', query: 'up' } },
      { id: 'ollama_call_1', name: 'logs_search', input: { source: 'loki', q: 'error' } },
    ]);
  });

  it('parses mixed content + tool_calls', async () => {
    setupFetchQueue([
      makeResponse(TOOL_CAPABLE_SHOW),
      makeResponse({
        model: 'llama3.1',
        message: {
          role: 'assistant',
          content: 'Let me check that.',
          tool_calls: [
            {
              function: {
                name: 'metrics_query',
                arguments: { sourceId: 'prom', query: 'up' },
              },
            },
          ],
        },
      }),
    ]);
    const provider = new OllamaProvider();
    const res = await provider.complete(MESSAGES, OPTS);
    expect(res.content).toBe('Let me check that.');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]).toEqual({
      id: 'ollama_call_0',
      name: 'metrics_query',
      input: { sourceId: 'prom', query: 'up' },
    });
  });

  it('threads tool_name onto the role:tool message (normalized) for tool_result blocks', async () => {
    const { calls } = setupFetchQueue([
      makeResponse(TOOL_CAPABLE_SHOW),
      makeResponse({
        model: 'llama3.1',
        message: { role: 'assistant', content: 'ok' },
      }),
    ]);
    const provider = new OllamaProvider();
    await provider.complete(
      [
        { role: 'user', content: 'check' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'ollama_call_0',
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
              tool_use_id: 'ollama_call_0',
              tool_name: 'metrics.query',
              content: '1 1 1',
            },
          ],
        },
      ],
      OPTS,
    );

    const chatBody = JSON.parse((calls[1]!.init?.body as string) ?? '{}') as {
      messages: Array<{ role: string; tool_call_id?: string; name?: string; content?: string }>;
    };
    const toolMsg = chatBody.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool_call_id).toBe('ollama_call_0');
    expect(toolMsg!.name).toBe('metrics_query');
    expect(toolMsg!.content).toBe('1 1 1');
  });

  it('does NOT double-parse arguments (Ollama returns objects, not JSON strings)', async () => {
    setupFetchQueue([
      makeResponse(TOOL_CAPABLE_SHOW),
      makeResponse({
        model: 'llama3.1',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              function: {
                name: 'metrics_query',
                arguments: { nested: { key: 'val' }, n: 7 },
              },
            },
          ],
        },
      }),
    ]);
    const provider = new OllamaProvider();
    const res = await provider.complete(MESSAGES, OPTS);
    expect(res.toolCalls[0]!.input).toEqual({ nested: { key: 'val' }, n: 7 });
  });

  it('throws typed ProviderError on non-2xx chat responses', async () => {
    setupFetchQueue([
      makeResponse(TOOL_CAPABLE_SHOW),
      makeBadResponse(503, 'model overloaded'),
    ]);
    const provider = new OllamaProvider();

    const promise = provider.complete(MESSAGES, OPTS);
    await expect(promise).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'server_error',
      provider: 'ollama',
      status: 503,
      upstreamBody: 'model overloaded',
    });
    await expect(promise).rejects.toBeInstanceOf(ProviderError);
  });
});
