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
// are NOT allowed. Our canonical names use dots (e.g. `metrics.query`). We map
// `.` -> `_` outbound and reverse on the way back.
//
// Collision risk: `dashboard.add_panels` and `dashboard_add_panels` would both
// collapse to `dashboard_add_panels`. We don't currently ship any tool name that
// natively contains an underscore in a position that would collide with a dotted
// counterpart, so a runtime check would be paranoid. Add one if/when the tool
// catalog grows large enough that the assumption is no longer obvious.
function nameToGemini(canonical: string): string {
  return canonical.replace(/\./g, '_');
}

function nameFromGemini(geminiName: string): string {
  return geminiName.replace(/_/g, '.');
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
          parts.push({ functionCall: { name: nameToGemini(b.name), args: b.input } });
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

    const response = await fetch(
      `${this.baseUrl}/v1beta/models/${model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
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
        const fc = (part as GeminiFunctionCallPart).functionCall;
        toolCalls.push({
          id: `gemini_call_${callIndex}`,
          name: nameFromGemini(fc.name),
          input: fc.args ?? {},
        });
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
    try {
      const response = await fetch(
        `${this.baseUrl}/v1beta/models?key=${this.apiKey}`,
      );
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        log.warn(
          { provider: 'gemini', status: response.status, body: body.slice(0, 200), baseUrl: this.baseUrl },
          'listModels failed',
        );
        return [];
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
    } catch (err) {
      log.warn({ err, provider: 'gemini', baseUrl: this.baseUrl }, 'listModels failed');
      return [];
    }
  }
}
