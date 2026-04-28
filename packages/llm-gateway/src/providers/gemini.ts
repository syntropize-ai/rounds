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
import { effortToBudgetTokens, getCapabilities } from './capabilities.js';

const log = createLogger('gemini-provider');

export interface GeminiConfig {
  apiKey: string;
  baseUrl?: string;
}

// -- Gemini wire-shape types (subset we use) --

interface GeminiTextPart {
  text: string;
  /** When true, this text is the model's reasoning summary, not the final answer. */
  thought?: boolean;
}

interface GeminiFunctionCallPart {
  functionCall: {
    name: string;
    args?: Record<string, unknown>;
  };
  /**
   * Opaque token Gemini attaches to functionCall parts on thinking-enabled
   * models. The next request that includes this functionCall in its history
   * MUST echo the signature back or the API rejects with 400
   * ("Function call is missing a thought_signature").
   */
  thoughtSignature?: string;
}

type GeminiResponsePart = GeminiTextPart | GeminiFunctionCallPart | Record<string, unknown>;

interface GeminiCandidate {
  content?: { parts?: GeminiResponsePart[]; role?: string };
  finishReason?: string;
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiResponseBody {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
}

interface GeminiModelsResponse {
  models: Array<{
    name: string;
    displayName: string;
    description?: string;
    inputTokenLimit?: number;
    supportedGenerationMethods?: string[];
  }>;
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: ToolDefinition['input_schema'];
}

interface GeminiToolConfig {
  functionCallingConfig: {
    mode: 'AUTO' | 'ANY' | 'NONE';
    allowedFunctionNames?: string[];
  };
}

// -- Tool-name normalization --
//
// Gemini's function name regex is roughly ^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$ — dots
// are NOT allowed. Our canonical names use dots (e.g. `metrics.query`,
// `metrics.metric_names`). Single `_` would be lossy: `metric_names` already
// contains an underscore, so a `.` -> `_` then `_` -> `.` round-trip turns
// `metrics.metric_names` into `metrics.metric.names` and the dispatch breaks.
//
// Encode `.` as `__` instead (same trick as the OpenAI provider). Double
// underscore is symmetrical and won't collide with our existing canonical
// names since none currently contain `__`.
const NAME_DELIM = '__';
function nameToGemini(canonical: string): string {
  return canonical.replace(/\./g, NAME_DELIM);
}

function nameFromGemini(geminiName: string): string {
  return geminiName.replace(new RegExp(NAME_DELIM, 'g'), '.');
}

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: GeminiConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com';
  }

  async complete(messages: CompletionMessage[], options: LLMOptions): Promise<LLMResponse> {
    const startTime = Date.now();
    const model = options.model ?? 'gemini-2.5-flash';

    // Convert messages to Gemini format
    const systemParts = messages.filter((m) => m.role === 'system');
    const conversationParts = messages.filter((m) => m.role !== 'system');

    // Translate canonical content blocks into Gemini's `parts` shape:
    //   text         -> { text }
    //   tool_use     -> { functionCall: { name, args } }       (assistant-side)
    //   tool_result  -> { functionResponse: { name, response } } (user-side)
    // Plain string content stays as a single text part.
    const contents = conversationParts.map((m) => {
      const role = m.role === 'assistant' ? 'model' : 'user';
      if (typeof m.content === 'string') {
        return { role, parts: [{ text: m.content }] };
      }
      const parts: Record<string, unknown>[] = [];
      for (const b of m.content as ContentBlock[]) {
        if (b.type === 'text') {
          parts.push({ text: b.text });
        } else if (b.type === 'tool_use') {
          // Echo the thoughtSignature back when present — Gemini thinking
          // models reject the request without it (400 "missing
          // thought_signature"). Stored on providerMetadata when we parsed
          // the original response.
          const meta = b.providerMetadata ?? {};
          const sig = typeof meta['thoughtSignature'] === 'string'
            ? (meta['thoughtSignature'] as string)
            : undefined;
          const part: Record<string, unknown> = {
            functionCall: { name: nameToGemini(b.name), args: b.input },
          };
          if (sig) part['thoughtSignature'] = sig;
          parts.push(part);
        } else if (b.type === 'tool_result') {
          // Gemini wants the tool result as a structured response; we emit text wrapped
          // in `result` so the model can read the observation regardless of shape.
          // Gemini pairs results to function calls by name (not id), so we mirror the
          // wire-name we used when emitting the matching functionCall part.
          parts.push({
            functionResponse: {
              name: nameToGemini(b.tool_name),
              response: { result: b.content },
            },
          });
        }
      }
      return { role, parts };
    });

    const body: Record<string, unknown> = { contents };

    if (systemParts.length > 0) {
      const flattenContent = (c: CompletionMessage['content']): string => {
        if (typeof c === 'string') return c;
        return c
          .filter((b) => b.type === 'text')
          .map((b) => (b as { type: 'text'; text: string }).text)
          .join('\n');
      };
      body['systemInstruction'] = {
        parts: [{ text: systemParts.map((s) => flattenContent(s.content)).join('\n') }],
      };
    }

    const generationConfig: Record<string, unknown> = {
      temperature: options.temperature,
      maxOutputTokens: options.maxTokens,
    };

    // Thinking — only on gemini-2.5+ and 3.x; older models 400 on the field
    if (options.thinking && getCapabilities('gemini', model).supportsThinking) {
      generationConfig['thinkingConfig'] = {
        thinkingBudget: effortToBudgetTokens(options.thinking.effort),
      };
    }

    body['generationConfig'] = generationConfig;

    if (options.tools && options.tools.length > 0) {
      const functionDeclarations: GeminiFunctionDeclaration[] = options.tools.map((t) => ({
        name: nameToGemini(t.name),
        description: t.description,
        parameters: t.input_schema,
      }));
      body['tools'] = [{ functionDeclarations }];
    }

    if (options.toolChoice !== undefined) {
      const toolConfig: GeminiToolConfig = {
        functionCallingConfig: {
          mode:
            options.toolChoice === 'any'
              ? 'ANY'
              : options.toolChoice === 'auto'
                ? 'AUTO'
                : typeof options.toolChoice === 'object' && options.toolChoice !== null
                  ? 'ANY'
                  : 'AUTO',
        },
      };
      if (typeof options.toolChoice === 'object' && options.toolChoice !== null) {
        toolConfig.functionCallingConfig.allowedFunctionNames = [
          nameToGemini(options.toolChoice.name),
        ];
      }
      body['toolConfig'] = toolConfig;
    }

    const fetchInit: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
    if (options.signal) fetchInit.signal = options.signal;
    const response = await fetch(
      `${this.baseUrl}/v1beta/models/${model}:generateContent?key=${this.apiKey}`,
      fetchInit,
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as GeminiResponseBody;
    const latencyMs = Date.now() - startTime;

    const firstCandidate = data.candidates?.[0];
    const parts: GeminiResponsePart[] = firstCandidate?.content?.parts ?? [];

    // Text parts: concat across all `{text: "..."}` fragments.
    // Gemini 2.5+ returns the model's reasoning as text parts with `thought: true`
    // — those go to thinkingBlocks rather than the user-facing content.
    const textPieces: string[] = [];
    const thinkingBlocks: string[] = [];
    // Function-call parts: synthesize an id since Gemini doesn't return one.
    // Format `gemini_call_<index>` keeps it deterministic and distinct per turn.
    // The id is provider-internal — when we send it back as a tool_result we
    // include the same string in the conversation history.
    const toolCalls: ToolCall[] = [];
    let callIndex = 0;
    for (const part of parts) {
      if (typeof (part as GeminiTextPart).text === 'string') {
        const tp = part as GeminiTextPart;
        if (tp.thought === true) {
          thinkingBlocks.push(tp.text);
        } else {
          textPieces.push(tp.text);
        }
      } else if (
        (part as GeminiFunctionCallPart).functionCall &&
        typeof (part as GeminiFunctionCallPart).functionCall.name === 'string'
      ) {
        const fcPart = part as GeminiFunctionCallPart;
        const fc = fcPart.functionCall;
        const tc: ToolCall = {
          id: `gemini_call_${callIndex}`,
          name: nameFromGemini(fc.name),
          input: fc.args ?? {},
        };
        // Thinking-enabled Gemini models attach a per-call thoughtSignature
        // that must be echoed on replay. Stash it in providerMetadata so the
        // agent loop can thread it through ContentBlock['tool_use'].
        if (typeof fcPart.thoughtSignature === 'string') {
          tc.providerMetadata = { thoughtSignature: fcPart.thoughtSignature };
        }
        toolCalls.push(tc);
        callIndex++;
      }
    }

    const usage = data.usageMetadata ?? {};

    return {
      content: textPieces.join(''),
      toolCalls,
      thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
      usage: {
        promptTokens: usage.promptTokenCount ?? 0,
        completionTokens: usage.candidatesTokenCount ?? 0,
        totalTokens: usage.totalTokenCount ?? 0,
      },
      model: data.modelVersion ?? model,
      latencyMs,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}/v1beta/models?key=${this.apiKey}`,
      );
    } catch (err) {
      const kind = classifyProviderHttpError({ cause: err });
      log.warn({ err, provider: 'gemini', baseUrl: this.baseUrl, kind }, 'listModels transport failure');
      throw new ProviderError(
        `Gemini listModels transport failure: ${err instanceof Error ? err.message : String(err)}`,
        { kind, provider: 'gemini', cause: err },
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const kind =
        response.status === 400 && /API key|INVALID_ARGUMENT/i.test(body)
          ? 'auth'
          : classifyProviderHttpError({ status: response.status });
      log.warn(
        { provider: 'gemini', status: response.status, body: body.slice(0, 200), baseUrl: this.baseUrl, kind },
        'listModels failed',
      );
      throw new ProviderError(
        `Gemini listModels failed: HTTP ${response.status} ${body.slice(0, 200)}`,
        { kind, provider: 'gemini', status: response.status },
      );
    }

    const data = (await response.json()) as GeminiModelsResponse;
    return data.models
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => ({
        id: m.name.replace('models/', ''),
        name: m.displayName,
        provider: 'gemini',
        contextWindow: m.inputTokenLimit,
        description: m.description,
      }));
  }
}
