import { createLogger } from '@agentic-obs/common/logging';
import type {
  LLMProvider,
  LLMOptions,
  LLMResponse,
  CompletionMessage,
  ModelInfo,
  ToolCall,
  ToolDefinition,
} from '../types.js';

const log = createLogger('openai-provider');

export interface OpenAIConfig {
  apiKey: string;
  baseUrl?: string;
}

// -- Tool name normalization --
//
// OpenAI's Chat Completions API restricts function names to
// `^[a-zA-Z0-9_-]{1,64}$`, so the dotted canonical names we use in agent-core
// (e.g. `metrics.query`, `dashboard.add_panels`) get rejected outright.
// We translate `.` <-> `__` on the wire. Double-underscore is unlikely to
// collide with our existing canonical names (none currently contain `__`),
// and is symmetrical so the round-trip is lossless. If a future canonical
// name ever uses `__` we'd need a richer encoding.
const NAME_DELIM = '__';

function nameToOpenAi(canonical: string): string {
  return canonical.replace(/\./g, NAME_DELIM);
}

function nameFromOpenAi(openai: string): string {
  return openai.replace(new RegExp(NAME_DELIM, 'g'), '.');
}

// -- OpenAI request/response shapes (the bits we touch) --

interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolDefinition['input_schema'];
  };
}

type OpenAIToolChoice =
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } }
  | undefined;

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON-encoded string of the arguments object. */
    arguments: string;
  };
}

interface OpenAIResponseBody {
  model: string;
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

function translateTools(tools: ToolDefinition[] | undefined): OpenAIToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: nameToOpenAi(t.name),
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function translateToolChoice(choice: LLMOptions['toolChoice']): OpenAIToolChoice {
  if (choice === undefined) return undefined;
  if (choice === 'auto') return 'auto';
  if (choice === 'any') return 'required';
  if (typeof choice === 'object' && choice.type === 'tool') {
    return { type: 'function', function: { name: nameToOpenAi(choice.name) } };
  }
  return undefined;
}

function parseToolCalls(raw: OpenAIToolCall[] | undefined): ToolCall[] {
  if (!raw || raw.length === 0) return [];
  return raw.map((tc) => {
    let input: Record<string, unknown> = {};
    try {
      const parsed: unknown = tc.function.arguments
        ? JSON.parse(tc.function.arguments)
        : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>;
      } else {
        log.warn(
          { provider: 'openai', toolCallId: tc.id, parsedType: typeof parsed },
          'tool_call.arguments JSON did not parse to an object; using empty input',
        );
      }
    } catch (err) {
      log.warn(
        { err, provider: 'openai', toolCallId: tc.id, args: tc.function.arguments?.slice(0, 200) },
        'tool_call.arguments was not valid JSON; using empty input',
      );
    }
    return {
      id: tc.id,
      name: nameFromOpenAi(tc.function.name),
      input,
    };
  });
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: OpenAIConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
  }

  async complete(messages: CompletionMessage[], options: LLMOptions): Promise<LLMResponse> {
    const startTime = Date.now();

    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
    };

    const tools = translateTools(options.tools);
    if (tools) body.tools = tools;

    const toolChoice = translateToolChoice(options.toolChoice);
    if (toolChoice !== undefined) body.tool_choice = toolChoice;

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as OpenAIResponseBody;
    const latencyMs = Date.now() - startTime;

    const firstChoice = data.choices[0]!;
    const message = firstChoice.message;

    return {
      content: message.content ?? '',
      toolCalls: parseToolCalls(message.tool_calls),
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      },
      model: data.model,
      latencyMs,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        log.warn(
          { provider: 'openai', status: response.status, body: body.slice(0, 200), baseUrl: this.baseUrl },
          'listModels failed',
        );
        return [];
      }
      const data = (await response.json()) as { data: Array<{ id: string; owned_by?: string }> };
      return data.data
        .filter((m) => m.id.startsWith('gpt'))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((m) => ({
          id: m.id,
          name: m.id,
          provider: 'openai',
        }));
    } catch (err) {
      log.warn({ err, provider: 'openai', baseUrl: this.baseUrl }, 'listModels failed');
      return [];
    }
  }
}
