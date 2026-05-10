/**
 * Measurement harness — OpenAI-compatible (OpenRouter / OpenAI / etc.)
 * variant of measure-tool-search.ts.
 *
 * Drives a Chat Completions endpoint with the production orchestrator
 * system prompt + always-on/deferred tool config. Counts tool_search
 * invocations per investigation prompt before any real-work tool fires.
 *
 * Run (OpenRouter):
 *   OPENAI_API_KEY=sk-or-v1-... \
 *   OPENAI_BASE_URL=https://openrouter.ai/api/v1 \
 *   OPENAI_MODEL=meta-llama/llama-3.3-70b-instruct:free \
 *     npx tsx tests/scripts/measure-tool-search-openrouter.ts
 *
 * Caveats:
 * 1. Free models on OpenRouter vary widely in tool-use quality. Many
 *    free models DON'T reliably support function calling — the
 *    response will have no tool_calls, the loop ends after one turn.
 *    Tool-use-capable free options to try (subject to availability):
 *      - meta-llama/llama-3.3-70b-instruct:free
 *      - mistralai/mistral-small-3.1-24b-instruct:free
 *      - nousresearch/hermes-3-llama-3.1-405b:free
 *      - deepseek/deepseek-chat-v3.1:free
 * 2. Smaller / weaker models will produce different tool_search behavior
 *    than Opus 4.6/4.7. This is a smoke test of "does the loop work
 *    end-to-end + is web_search ever invoked at all", NOT a measurement
 *    of how Opus 4.x specifically behaves.
 * 3. The Anthropic prompt-cache marker (SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
 *    is stripped before sending — OpenAI/OpenRouter don't cache prompts
 *    in the same shape, so the marker would just be noise.
 */

import 'dotenv/config';
import { buildSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../../packages/agent-core/src/agent/orchestrator-prompt.js';
import {
  TOOL_SCHEMAS,
  alwaysOnToolsForAgent,
  deferredToolNamesForAgent,
  deferredSchemasByName,
} from '../../packages/agent-core/src/agent/tool-schema-registry.js';
import { searchTools, selectTools } from '../../packages/agent-core/src/agent/tool-search.js';
import { agentRegistry } from '../../packages/agent-core/src/agent/agent-registry.js';

interface OAITool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
interface OAIToolCall { id: string; type: 'function'; function: { name: string; arguments: string }; }
interface OAIAssistantMsg { role: 'assistant'; content: string | null; tool_calls?: OAIToolCall[]; }
interface OAIUserMsg { role: 'user' | 'system'; content: string; }
interface OAIToolMsg { role: 'tool'; tool_call_id: string; content: string; }
type OAIMsg = OAIAssistantMsg | OAIUserMsg | OAIToolMsg;

const MAX_TURNS = 10;

const PROMPTS = [
  // Generic investigation — no vendor-specific metric in the prompt itself.
  // web_search trigger 2 ("hits an unfamiliar metric") needs the model to
  // notice an unknown name MID-investigation. With canned generic metric
  // names this trigger has no surface to fire on.
  'Why is p99 latency on api-gateway so high in the last hour?',
  'Investigate why our error rate spiked at 14:30',
  // Named-system dashboard — trigger 1.
  'Build a Redis monitoring dashboard',
  // Vendor-specific metric DIRECTLY in the prompt — should trigger 2 if
  // the model reads "this is a name I should look up".
  'Why is redis_aof_rewrite_in_progress always 1 on our Redis primary?',
  'Investigate why kafka_consumergroup_lag is climbing on group=orders-svc',
];

function cannedToolResult(name: string): string {
  switch (name) {
    case 'connectors_list':
      return JSON.stringify([{ id: 'prom-prod', name: 'prom-prod', type: 'prometheus', isDefault: true }]);
    case 'connectors_suggest':
      return JSON.stringify({ chosen: { id: 'prom-prod', type: 'prometheus' }, alternatives: [] });
    case 'investigation_create':
      return JSON.stringify({ investigationId: 'inv-test-123' });
    case 'metrics_query':
      return JSON.stringify({ value: 0.099, unit: 'seconds' });
    case 'metrics_range_query':
      return JSON.stringify({ samples: [[1700000000, '0.05'], [1700001800, '0.099']] });
    case 'metrics_discover':
      return JSON.stringify({ names: ['http_requests_total', 'http_request_duration_seconds_bucket'] });
    case 'changes_list_recent':
      return JSON.stringify({ changes: [] });
    case 'investigation_add_section':
      return JSON.stringify({ sectionId: 's-' + Math.random().toString(36).slice(2, 8) });
    case 'investigation_complete':
      return JSON.stringify({ ok: true });
    case 'web_search':
      return JSON.stringify({
        results: [
          { title: 'redis_exporter metrics', url: 'https://example.com/redis', snippet: 'redis_connected_clients, redis_used_memory_bytes, redis_commands_processed_total' },
        ],
      });
    case 'dashboard_create':
      return JSON.stringify({ dashboardId: 'dash-test-456' });
    default:
      return JSON.stringify({ ok: true, note: `canned result for ${name}` });
  }
}

function resolveToolSearch(input: Record<string, unknown>, allowedDeferred: Set<string>): { observation: string; loaded: string[] } {
  const query = String(input['query'] ?? '');
  let matched: { name: string; description: string; input_schema: Record<string, unknown> }[];
  if (query.toLowerCase().startsWith('select:')) {
    const names = query.slice('select:'.length).split(',').map((s) => s.trim()).filter(Boolean);
    matched = selectTools(names, TOOL_SCHEMAS) as never;
  } else {
    matched = searchTools(query, TOOL_SCHEMAS) as never;
  }
  matched = matched.filter((t) => allowedDeferred.has(t.name));
  const loaded = matched.map((t) => t.name);
  if (loaded.length === 0) {
    return { observation: `<functions>\n(no tools matched query "${query}")\n</functions>`, loaded };
  }
  const blocks = matched.map((t) => `<function>${JSON.stringify({ name: t.name, description: t.description, parameters: t.input_schema })}</function>`).join('\n');
  return { observation: `<functions>\n${blocks}\n</functions>`, loaded };
}

function toOAITools(defs: { name: string; description: string; input_schema: Record<string, unknown> }[]): OAITool[] {
  return defs.map((d) => ({
    type: 'function',
    function: { name: d.name, description: d.description, parameters: d.input_schema },
  }));
}

async function callOpenAI(model: string, apiKey: string, baseUrl: string, messages: OAIMsg[], tools: OAITool[]): Promise<{ assistant: OAIAssistantMsg }> {
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0,
    max_tokens: 4096,
  };
  if (tools.length > 0) {
    body['tools'] = tools;
    body['tool_choice'] = 'auto';
  }
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      // OpenRouter headers — harmless for native OpenAI, identifies traffic.
      'HTTP-Referer': 'https://github.com/openobs/openobs',
      'X-Title': 'openobs tool_search measurement',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    throw new Error(`openai ${r.status}: ${(await r.text().catch(() => '')).slice(0, 500)}`);
  }
  const j = (await r.json()) as { choices: { message: OAIAssistantMsg }[] };
  const msg = j.choices?.[0]?.message;
  if (!msg) throw new Error(`openai: no choices in response`);
  return { assistant: msg };
}

interface Trace {
  prompt: string;
  totalTurns: number;
  toolSearchCount: number;
  webSearchCount: number;
  toolNames: string[];
  hallucinated: string[]; // tools called but NOT in toolsForTurn (model invented or pulled from prompt prose)
  firstNonSearchToolAtTurn: number | null;
  endedReason: 'plain-text' | 'max-turns' | 'enough-work' | 'no-tool-support';
}

async function runOne(model: string, apiKey: string, baseUrl: string, prompt: string): Promise<Trace> {
  const orch = agentRegistry.get('orchestrator')!;
  const allowedTools = orch.allowedTools;

  // Build system prompt and strip the Anthropic cache-boundary marker — it
  // would show up as literal text to OpenAI/OpenRouter.
  const rawSystem = buildSystemPrompt(null, [], [], null, [
    { id: 'prom-prod', name: 'prom-prod', type: 'prometheus', isDefault: true } as never,
  ], { hasPrometheus: true, now: new Date().toISOString() });
  const systemPrompt = rawSystem.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY).join('').replace(/\n{3,}/g, '\n\n');

  const alwaysOn = alwaysOnToolsForAgent(allowedTools) as never;
  const deferredNames = new Set(deferredToolNamesForAgent(allowedTools));
  const loaded = new Set<string>();
  const toolsForTurn = (): OAITool[] => toOAITools([...alwaysOn, ...deferredSchemasByName(loaded) as never]);

  const messages: OAIMsg[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ];

  const trace: Trace = {
    prompt,
    totalTurns: 0,
    toolSearchCount: 0,
    webSearchCount: 0,
    toolNames: [],
    hallucinated: [],
    firstNonSearchToolAtTurn: null,
    endedReason: 'max-turns',
  };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    trace.totalTurns = turn + 1;
    const { assistant } = await callOpenAI(model, apiKey, baseUrl, messages, toolsForTurn());

    const tools = assistant.tool_calls ?? [];
    if (tools.length === 0) {
      trace.endedReason = turn === 0 ? 'no-tool-support' : 'plain-text';
      break;
    }

    messages.push({
      role: 'assistant',
      content: assistant.content ?? null,
      tool_calls: tools,
    });

    const exposedNames = new Set(toolsForTurn().map((t) => t.function.name));
    for (const tc of tools) {
      const name = tc.function.name;
      let input: Record<string, unknown>;
      try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
      trace.toolNames.push(name);
      if (!exposedNames.has(name)) trace.hallucinated.push(name);
      let resultText: string;
      if (name === 'tool_search') {
        trace.toolSearchCount++;
        const r = resolveToolSearch(input, deferredNames);
        for (const n of r.loaded) loaded.add(n);
        resultText = r.observation;
      } else {
        if (name === 'web_search') trace.webSearchCount++;
        if (trace.firstNonSearchToolAtTurn === null) trace.firstNonSearchToolAtTurn = turn + 1;
        resultText = cannedToolResult(name);
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
    }

    const nonSearch = trace.toolNames.filter((n) => n !== 'tool_search').length;
    if (nonSearch >= 4) {
      trace.endedReason = 'enough-work';
      break;
    }
  }
  return trace;
}

async function main() {
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  const baseUrl = (process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env['OPENAI_MODEL'] ?? 'meta-llama/llama-3.3-70b-instruct:free';

  const orch = agentRegistry.get('orchestrator')!;
  console.log(`Endpoint: ${baseUrl}`);
  console.log(`Model:    ${model}`);
  console.log(`Always-on tools (${alwaysOnToolsForAgent(orch.allowedTools).length}): ${alwaysOnToolsForAgent(orch.allowedTools).map((t) => t.name).join(', ')}`);
  console.log(`Deferred tools (${deferredToolNamesForAgent(orch.allowedTools).length}): ${deferredToolNamesForAgent(orch.allowedTools).join(', ')}`);
  console.log('');

  const traces: Trace[] = [];
  for (const p of PROMPTS) {
    process.stdout.write(`→ "${p.slice(0, 60)}..."  `);
    try {
      const t = await runOne(model, apiKey, baseUrl, p);
      traces.push(t);
      console.log(
        `turns=${t.totalTurns} tool_search=${t.toolSearchCount} web_search=${t.webSearchCount} ` +
        `firstWork@${t.firstNonSearchToolAtTurn ?? 'never'} ended=${t.endedReason}` +
        (t.hallucinated.length > 0 ? ` ⚠️hallucinated=[${t.hallucinated.join(',')}]` : '') +
        `\n   sequence: ${t.toolNames.join(' → ') || '(no tools called)'}`,
      );
    } catch (e) {
      console.log(`ERROR: ${(e as Error).message}`);
    }
  }

  console.log('');
  console.log('=== Summary ===');
  if (traces.length === 0) { console.log('No successful runs.'); return; }
  const avgSearch = (traces.reduce((s, t) => s + t.toolSearchCount, 0) / traces.length).toFixed(2);
  const avgWeb = (traces.reduce((s, t) => s + t.webSearchCount, 0) / traces.length).toFixed(2);
  const avgFirstWork = (traces.reduce((s, t) => s + (t.firstNonSearchToolAtTurn ?? MAX_TURNS), 0) / traces.length).toFixed(2);
  const noTool = traces.filter((t) => t.endedReason === 'no-tool-support').length;
  console.log(`Runs:                       ${traces.length}`);
  console.log(`Avg tool_search calls:      ${avgSearch}`);
  console.log(`Avg web_search calls:       ${avgWeb}      ← key metric for "model uses web_search?"`);
  console.log(`Avg turn of first real work: ${avgFirstWork}`);
  console.log(`Per-run tool_search counts: [${traces.map((t) => t.toolSearchCount).join(', ')}]`);
  console.log(`Per-run web_search counts:  [${traces.map((t) => t.webSearchCount).join(', ')}]`);
  if (noTool > 0) {
    console.log(`\n⚠️  ${noTool}/${traces.length} run(s) ended at turn 1 with no tool calls — model probably doesn't support function calling, results not interpretable.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
