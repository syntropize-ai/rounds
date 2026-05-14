/**
 * Unit tests for the Gemini provider's native tool_use wiring.
 *
 * Stubs global `fetch` to verify:
 *   - canonical -> functionDeclarations translation (dot-name normalization)
 *   - toolConfig.functionCallingConfig mapping for each toolChoice variant
 *   - response parsing for parts[] containing:
 *       - text-only
 *       - functionCall-only
 *       - mixed text + functionCall
 *       - multiple functionCall parts in one turn
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GeminiProvider } from '../gemini.js';
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

const baseUsage = {
  promptTokenCount: 10,
  candidatesTokenCount: 5,
  totalTokenCount: 15,
};

describe('GeminiProvider', () => {
  let provider: GeminiProvider;

  beforeEach(() => {
    provider = new GeminiProvider({ apiKey: 'test-key', baseUrl: 'https://gemini.example' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('request translation', () => {
    it('translates canonical tools to functionDeclarations and normalizes dot names', async () => {
      const spy = mockFetch(async () =>
        makeJsonResponse({
          candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
          usageMetadata: baseUsage,
          modelVersion: 'gemini-2.5-flash',
        }),
      );

      await provider.complete([{ role: 'user', content: 'hi' }], {
        model: 'gemini-2.5-flash',
        tools: [queryTool, logsTool],
      });

      const body = getRequestBody(spy);
      expect(body['tools']).toEqual([
        {
          functionDeclarations: [
            {
              name: 'metrics__query',
              description: 'Query a metrics source',
              parameters: queryTool.input_schema,
            },
            {
              name: 'logs__search',
              description: 'Search logs',
              parameters: logsTool.input_schema,
            },
          ],
        },
      ]);
      // Dot-name was normalized — outbound never contains '.'
      const decls = (
        (body['tools'] as Array<{ functionDeclarations: Array<{ name: string }> }>)[0]
      )!.functionDeclarations;
      for (const d of decls) {
        expect(d.name).not.toContain('.');
      }
    });

    it('omits tools / toolConfig when not requested', async () => {
      const spy = mockFetch(async () =>
        makeJsonResponse({
          candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] } }],
          usageMetadata: baseUsage,
        }),
      );

      await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-2.5-flash' });

      const body = getRequestBody(spy);
      expect(body['tools']).toBeUndefined();
      expect(body['toolConfig']).toBeUndefined();
    });

    it("maps toolChoice 'auto' -> AUTO", async () => {
      const spy = mockFetch(async () =>
        makeJsonResponse({
          candidates: [{ content: { role: 'model', parts: [{ text: 'x' }] } }],
          usageMetadata: baseUsage,
        }),
      );

      await provider.complete([{ role: 'user', content: 'hi' }], {
        model: 'gemini-2.5-flash',
        tools: [queryTool],
        toolChoice: 'auto',
      });

      const body = getRequestBody(spy);
      expect(body['toolConfig']).toEqual({
        functionCallingConfig: { mode: 'AUTO' },
      });
    });

    it("maps toolChoice 'any' -> ANY", async () => {
      const spy = mockFetch(async () =>
        makeJsonResponse({
          candidates: [{ content: { role: 'model', parts: [{ text: 'x' }] } }],
          usageMetadata: baseUsage,
        }),
      );

      await provider.complete([{ role: 'user', content: 'hi' }], {
        model: 'gemini-2.5-flash',
        tools: [queryTool],
        toolChoice: 'any',
      });

      const body = getRequestBody(spy);
      expect(body['toolConfig']).toEqual({
        functionCallingConfig: { mode: 'ANY' },
      });
    });

    it("maps toolChoice {type:'tool',name} -> ANY + allowedFunctionNames (normalized)", async () => {
      const spy = mockFetch(async () =>
        makeJsonResponse({
          candidates: [{ content: { role: 'model', parts: [{ text: 'x' }] } }],
          usageMetadata: baseUsage,
        }),
      );

      await provider.complete([{ role: 'user', content: 'hi' }], {
        model: 'gemini-2.5-flash',
        tools: [queryTool],
        toolChoice: { type: 'tool', name: 'metrics.query' },
      });

      const body = getRequestBody(spy);
      expect(body['toolConfig']).toEqual({
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: ['metrics__query'],
        },
      });
    });
  });

  describe('response parsing', () => {
    it('returns content from text-only parts and empty toolCalls', async () => {
      mockFetch(async () =>
        makeJsonResponse({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'hello ' }, { text: 'world' }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: baseUsage,
          modelVersion: 'gemini-2.5-flash-001',
        }),
      );

      const res = await provider.complete([{ role: 'user', content: 'hi' }], {
        model: 'gemini-2.5-flash',
      });

      expect(res.content).toBe('hello world');
      expect(res.toolCalls).toEqual([]);
      expect(res.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
      expect(res.model).toBe('gemini-2.5-flash-001');
    });

    it('parses functionCall parts into toolCalls (denormalizes name, synthesizes id)', async () => {
      mockFetch(async () =>
        makeJsonResponse({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      name: 'metrics__query',
                      args: { sourceId: 'prom', query: 'up' },
                    },
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: baseUsage,
        }),
      );

      const res = await provider.complete([{ role: 'user', content: 'check' }], {
        model: 'gemini-2.5-flash',
        tools: [queryTool],
      });

      expect(res.content).toBe('');
      expect(res.toolCalls).toEqual([
        {
          id: 'gemini_call_0',
          name: 'metrics.query',
          input: { sourceId: 'prom', query: 'up' },
        },
      ]);
    });

    it('handles a functionCall with missing args by defaulting to {}', async () => {
      mockFetch(async () =>
        makeJsonResponse({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ functionCall: { name: 'logs__search' } }],
              },
            },
          ],
          usageMetadata: baseUsage,
        }),
      );

      const res = await provider.complete([{ role: 'user', content: 'check' }], {
        model: 'gemini-2.5-flash',
        tools: [logsTool],
      });

      expect(res.toolCalls).toEqual([
        { id: 'gemini_call_0', name: 'logs.search', input: {} },
      ]);
    });

    it('parses mixed text + multiple functionCall parts in one turn', async () => {
      mockFetch(async () =>
        makeJsonResponse({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: 'Let me check the metrics ' },
                  {
                    functionCall: {
                      name: 'metrics__query',
                      args: { sourceId: 'prom', query: 'up' },
                    },
                  },
                  { text: 'and the logs.' },
                  {
                    functionCall: {
                      name: 'logs__search',
                      args: { q: 'error' },
                    },
                  },
                ],
              },
            },
          ],
          usageMetadata: baseUsage,
        }),
      );

      const res = await provider.complete([{ role: 'user', content: 'check' }], {
        model: 'gemini-2.5-flash',
        tools: [queryTool, logsTool],
      });

      expect(res.content).toBe('Let me check the metrics and the logs.');
      expect(res.toolCalls).toEqual([
        {
          id: 'gemini_call_0',
          name: 'metrics.query',
          input: { sourceId: 'prom', query: 'up' },
        },
        {
          id: 'gemini_call_1',
          name: 'logs.search',
          input: { q: 'error' },
        },
      ]);
    });

    it('throws typed ProviderError on non-2xx with status + body metadata', async () => {
      mockFetch(async () =>
        new Response('quota exceeded', {
          status: 429,
          headers: new Headers({ 'content-type': 'text/plain' }),
        }),
      );

      await expect(
        provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-2.5-flash' }),
      ).rejects.toMatchObject({
        name: 'ProviderError',
        kind: 'rate_limit',
        provider: 'gemini',
        status: 429,
        upstreamBody: 'quota exceeded',
      });
      await expect(
        provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-2.5-flash' }),
      ).rejects.toBeInstanceOf(ProviderError);
    });
  });

  describe('tool_result wiring', () => {
    it('uses tool_name (normalized) for functionResponse.name', async () => {
      const spy = mockFetch(async () =>
        makeJsonResponse({
          candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
          usageMetadata: baseUsage,
        }),
      );

      await provider.complete(
        [
          { role: 'user', content: 'check' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'gemini_call_0',
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
                tool_use_id: 'gemini_call_0',
                tool_name: 'metrics.query',
                content: '1 1 1',
              },
            ],
          },
        ],
        { model: 'gemini-2.5-flash' },
      );

      const body = getRequestBody(spy);
      const contents = body['contents'] as Array<{
        role: string;
        parts: Array<Record<string, unknown>>;
      }>;
      // contents[0] = initial user prompt
      // contents[1] = assistant turn with functionCall (mapped to role: 'model')
      // contents[2] = the tool_result turn — carries functionResponse with the matching name.
      const responsePart = contents[2]!.parts[0] as {
        functionResponse: { name: string; response: { result: string } };
      };
      expect(responsePart.functionResponse.name).toBe('metrics__query');
      expect(responsePart.functionResponse.response.result).toBe('1 1 1');
    });
  });

  describe('message wiring', () => {
    it('separates system into systemInstruction and maps assistant -> model', async () => {
      const spy = mockFetch(async () =>
        makeJsonResponse({
          candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
          usageMetadata: baseUsage,
        }),
      );

      await provider.complete(
        [
          { role: 'system', content: 'be terse' },
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
          { role: 'user', content: 'again' },
        ],
        { model: 'gemini-2.5-flash' },
      );

      const body = getRequestBody(spy);
      expect(body['systemInstruction']).toEqual({
        parts: [{ text: 'be terse' }],
      });
      expect(body['contents']).toEqual([
        { role: 'user', parts: [{ text: 'hi' }] },
        { role: 'model', parts: [{ text: 'hello' }] },
        { role: 'user', parts: [{ text: 'again' }] },
      ]);
    });
  });

  describe('listModels', () => {
    it('classifies Gemini invalid API key responses as auth errors', async () => {
      mockFetch(async () =>
        makeJsonResponse(
          {
            error: {
              code: 400,
              message: 'API key not valid. Please pass a valid API key.',
              status: 'INVALID_ARGUMENT',
            },
          },
          400,
        ),
      );

      await expect(provider.listModels()).rejects.toMatchObject({
        kind: 'auth_failure',
        provider: 'gemini',
        status: 400,
      });
    });
  });
});
