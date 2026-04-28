import { describe, expect, it, vi } from 'vitest';
import { createLlmProvider } from './llm-factory.js';

describe('createLlmProvider', () => {
  it('uses DeepSeek v1 endpoint for chat completions by default', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        model: 'deepseek-chat',
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as Response);

    try {
      const provider = createLlmProvider({
        provider: 'deepseek',
        apiKey: 'sk-test',
        model: 'deepseek-chat',
      });
      await provider.complete(
        [{ role: 'user', content: 'hello' }],
        { model: 'deepseek-chat' },
      );

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.deepseek.com/v1/chat/completions',
        expect.any(Object),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });
});
