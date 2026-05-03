import { createLogger } from '@agentic-obs/common/logging';
import type {
  LLMProvider,
  LLMOptions,
  LLMResponse,
  CompletionMessage,
  ContentBlock,
  ModelInfo,
  ToolCall,
  ToolDefinition,
} from '../types.js';
import { ProviderError, classifyProviderHttpError } from '../types.js';
import { ProviderCapabilityError } from './capabilities.js';
import { stripCacheBoundary } from '../system-prompt-cache-boundary.js';

const log = createLogger('ollama-provider');

// -- Tool name normalization --
//
// Ollama follows OpenAI naming rules for function tools: `^[a-zA-Z0-9_-]{1,64}$`.
// Our canonical names use dots (`metrics.query`); translate `.` <-> `_` on the
// wire. A single underscore is the simplest safe encoding for Ollama.
function nameToOllama(canonical: string): string {
  return canonical.replace(/\./g, '_');
}

function nameFromOllama(wire: string): string {
  // Best-effort reverse — we don't translate `_` back to `.` because that would
  // mangle names that legitimately use underscores. Callers compare the names
  // they sent, so leave the wire form alone.
  return wire;
}

export interface OllamaConfig {
  baseUrl?: string;
}

interface OllamaToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolDefinition['input_schema'];
  };
}

interface OllamaToolCall {
  function: {
    name: string;
    /** Ollama returns the arguments as an already-parsed object (NOT a string). */
    arguments: Record<string, unknown>;
  };
}

interface OllamaChatResponse {
  model: string;
  message: {
    role: string;
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaTagsResponse {
  models: Array<{
    name: string;
    model: string;
    size: number;
    details: {
      parameter_size?: string;
      family?: string;
      format?: string;
    };
  }>;
}

interface OllamaShowResponse {
  capabilities?: string[];
}

function translateTools(tools: ToolDefinition[] | undefined): OllamaToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: nameToOllama(t.name),
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

// -- Message translation: canonical (Anthropic-flavor blocks) -> Ollama/OpenAI shape --
//
// Ollama's /api/chat follows the OpenAI message shape: assistant tool calls go in
// a separate `tool_calls` field (not `content`), and tool results are standalone
// `role: "tool"` messages with `tool_call_id`.
interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_call_id?: string;
  /** Optional on `role: 'tool'` messages — echoes the function name. */
  name?: string;
}

function translateMessages(messages: CompletionMessage[]): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      const content = m.role === 'system' ? stripCacheBoundary(m.content) : m.content;
      out.push({ role: m.role, content });
      continue;
    }
    const blocks = m.content as ContentBlock[];
    if (m.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: OllamaMessage['tool_calls'] = [];
      for (const b of blocks) {
        if (b.type === 'text') textParts.push(b.text);
        else if (b.type === 'tool_use') {
          toolCalls.push({
            function: { name: nameToOllama(b.name), arguments: b.input },
          });
        }
      }
      const msg: OllamaMessage = { role: 'assistant', content: textParts.join('\n') };
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      out.push(msg);
    } else if (m.role === 'user') {
      const textParts: string[] = [];
      for (const b of blocks) {
        if (b.type === 'text') textParts.push(b.text);
        else if (b.type === 'tool_result') {
          out.push({
            role: 'tool',
            tool_call_id: b.tool_use_id,
            name: nameToOllama(b.tool_name),
            content: b.content,
          });
        }
      }
      if (textParts.length > 0) {
        out.push({ role: 'user', content: textParts.join('\n') });
      }
    } else {
      const textParts = blocks
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text);
      // Ollama has no cache breakpoint primitive — strip the marker.
      out.push({ role: 'system', content: stripCacheBoundary(textParts.join('\n')) });
    }
  }
  return out;
}

function parseToolCalls(raw: OllamaToolCall[] | undefined): ToolCall[] {
  if (!raw || raw.length === 0) return [];
  return raw.map((tc, i) => {
    const args = tc.function.arguments;
    const input: Record<string, unknown> =
      args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    return {
      id: `ollama_call_${i}`,
      name: nameFromOllama(tc.function.name),
      input,
    };
  });
}

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  private readonly baseUrl: string;
  /**
   * Cached capability probe. Populated on the first `complete()` call and
   * reused on every subsequent call so we hit `/api/show` at most once per
   * (provider instance, model). Keyed by model — different models on the same
   * Ollama instance can have different capabilities.
   */
  private readonly probeCache = new Map<string, Promise<void>>();

  constructor(config: OllamaConfig = {}) {
    this.baseUrl = config.baseUrl || 'http://localhost:11434';
  }

  async complete(messages: CompletionMessage[], options: LLMOptions): Promise<LLMResponse> {
    const startTime = Date.now();
    const model = options.model ?? 'llama3.1';

    // Capability probe — cached after first success, retried on failure.
    await this.ensureToolCapability(model);

    const body: Record<string, unknown> = {
      model,
      messages: translateMessages(messages),
      stream: false,
      options: {
        temperature: options.temperature,
        num_predict: options.maxTokens,
      },
    };

    const tools = translateTools(options.tools);
    if (tools) body.tools = tools;

    const fetchInit: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
    if (options.signal) fetchInit.signal = options.signal;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, fetchInit);
    } catch (err) {
      const kind = classifyProviderHttpError({ cause: err });
      throw new ProviderError(
        `Ollama complete transport failure: ${err instanceof Error ? err.message : String(err)}`,
        { kind, provider: this.name, cause: err },
      );
    }

    if (!response.ok) {
      const errorText = await response.text();
      const kind = classifyProviderHttpError({ status: response.status });
      throw new ProviderError(
        `Ollama complete failed: HTTP ${response.status} ${errorText.slice(0, 200)}`,
        {
          kind,
          provider: this.name,
          status: response.status,
          upstreamBody: errorText.slice(0, 1000),
        },
      );
    }

    const data = (await response.json()) as OllamaChatResponse;
    const latencyMs = Date.now() - startTime;

    return {
      content: data.message.content ?? '',
      toolCalls: parseToolCalls(data.message.tool_calls),
      usage: {
        promptTokens: data.prompt_eval_count ?? 0,
        completionTokens: data.eval_count ?? 0,
        totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      },
      model: data.model,
      latencyMs,
    };
  }

  /**
   * Probe `/api/show` and verify the model declares the `tools` capability.
   * Throws ProviderCapabilityError on miss; cached on success so we only
   * hit the endpoint once per model. On failure, the cache entry is purged
   * so the next call retries (e.g. user pulled a different model).
   */
  private async ensureToolCapability(model: string): Promise<void> {
    const cached = this.probeCache.get(model);
    if (cached) {
      await cached;
      return;
    }
    const probe = this.probeToolCapability(model);
    this.probeCache.set(model, probe);
    try {
      await probe;
    } catch (err) {
      this.probeCache.delete(model);
      throw err;
    }
  }

  private async probeToolCapability(model: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model }),
      });
    } catch (err) {
      throw new ProviderCapabilityError(
        `Ollama capability probe failed: could not reach ${this.baseUrl}/api/show — ` +
          `${err instanceof Error ? err.message : String(err)}. Is the Ollama daemon running?`,
      );
    }

    if (!response.ok) {
      throw new ProviderCapabilityError(
        `Ollama capability probe failed for model "${model}": /api/show returned ${response.status}. ` +
          `Is the model pulled? Run \`ollama pull ${model}\`.`,
      );
    }

    let data: OllamaShowResponse;
    try {
      data = (await response.json()) as OllamaShowResponse;
    } catch (err) {
      throw new ProviderCapabilityError(
        `Ollama capability probe failed for model "${model}": invalid JSON from /api/show — ` +
          `${err instanceof Error ? err.message : String(err)}.`,
      );
    }

    const caps = Array.isArray(data?.capabilities) ? data.capabilities : [];
    const supportsTools = caps.includes('tools');
    if (!supportsTools) {
      throw new ProviderCapabilityError(
        `Ollama model "${model}" does not support tool calling. ` +
          `Pick a tool-capable model — llama3.1, llama3.2, qwen2.5, mistral, qwen3 are good defaults. ` +
          `Run \`ollama show ${model}\` to verify capabilities.`,
      );
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/tags`);
    } catch (err) {
      const kind = classifyProviderHttpError({ cause: err });
      log.warn({ err, provider: 'ollama', baseUrl: this.baseUrl, kind }, 'listModels transport failure');
      throw new ProviderError(
        `Ollama listModels transport failure: ${err instanceof Error ? err.message : String(err)}`,
        { kind, provider: 'ollama', cause: err },
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const kind = classifyProviderHttpError({ status: response.status });
      log.warn(
        { provider: 'ollama', status: response.status, body: body.slice(0, 200), baseUrl: this.baseUrl, kind },
        'listModels failed',
      );
      throw new ProviderError(
        `Ollama listModels failed: HTTP ${response.status} ${body.slice(0, 200)}`,
        { kind, provider: 'ollama', status: response.status },
      );
    }

    const data = (await response.json()) as OllamaTagsResponse;
    return data.models.map((m) => ({
      id: m.name,
      name: m.name,
      provider: 'ollama',
      description: [m.details.family, m.details.parameter_size].filter(Boolean).join(' · '),
    }));
  }
}
