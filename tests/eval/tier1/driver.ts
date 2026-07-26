/**
 * Driving the product the way a person does: type a question into chat, wait,
 * read the report.
 *
 * Deliberately not a shortcut. There is an internal path that would let the
 * harness call the investigation orchestrator directly, and using it would
 * make runs faster and far less flaky — and would stop measuring the product.
 * Whether the agent decides to open an investigation at all, from an ordinary
 * sentence, is part of what is being evaluated.
 *
 * The investigation id is found by diffing the list before and after rather
 * than by parsing the chat stream. The stream's event shapes are an internal
 * contract that changes; a new row with our question in it is not.
 */

const BASE_URL = process.env['ROUNDS_EVAL_URL'] ?? 'http://127.0.0.1:3000';
const TOKEN = process.env['ROUNDS_EVAL_TOKEN'] ?? '';

export class ApiUnreachable extends Error {
  constructor(detail: string) {
    super(`the product's API did not answer: ${detail}`);
    this.name = 'ApiUnreachable';
  }
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    throw new ApiUnreachable(`${method} ${path}: ${(err as Error).message}`);
  }
  // Same split as `ask`: 5xx and network failures are the product being
  // unavailable and excuse the run; 4xx is us asking wrongly and must not.
  if (res.status >= 500) throw new ApiUnreachable(`${method} ${path} -> ${res.status}`);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

interface InvestigationSummary { id: string; status: string; intent?: string }

export async function listInvestigationIds(): Promise<Set<string>> {
  const rows = await api<InvestigationSummary[]>('GET', '/api/investigations');
  return new Set(rows.map((r) => r.id));
}

/**
 * Ask the question, drain the stream, and report whether an investigation was
 * ever started.
 *
 * The response body must be read to completion, not just opened: the agent
 * runs while the stream is open, and abandoning it mid-flight can cut the run
 * short and score the product for work it was interrupted doing.
 *
 * The `investigation_create` sighting matters because a draft investigation
 * lives in memory until `investigation_complete` persists it. Without watching
 * the stream, an investigation that started and ran out of steam is
 * indistinguishable from one that was never opened — the row is absent either
 * way. Both grade as UNRESOLVED, but for working out *why* the answer rate is
 * low they are opposite findings: one is a model that did not engage, the
 * other is a model that engaged and could not finish.
 */
export async function ask(question: string): Promise<{ openedInvestigation: boolean }> {
  let res: Response;
  try {
    // No sessionId. The server mints one, which is both what a new
    // conversation does and what keeps runs isolated — a session carried
    // across runs would let one scenario's history inform the next one's
    // answer. Passing an invented id gets a 404: sessions must already exist.
    res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: question }),
    });
  } catch (err) {
    throw new ApiUnreachable(`POST /api/chat: ${(err as Error).message}`);
  }
  // A 4xx is the harness asking wrongly, not the product being down. Excluding
  // those runs would delete our own bugs from the denominator and report the
  // remainder as a measurement.
  if (res.status >= 400 && res.status < 500) {
    throw new Error(`POST /api/chat -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  if (!res.ok || !res.body) throw new ApiUnreachable(`POST /api/chat -> ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let openedInvestigation = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (value && decoder.decode(value, { stream: true }).includes('"investigation_create"')) {
      openedInvestigation = true;
    }
    if (done) return { openedInvestigation };
  }
}

/**
 * The investigation this question produced, or null if it produced none.
 *
 * Null is a real answer about the product — it decided a question about a
 * broken cluster did not warrant an investigation — so callers grade it rather
 * than discarding the run.
 */
export async function findNewInvestigation(
  before: Set<string>,
  question: string,
): Promise<string | null> {
  const rows = await api<InvestigationSummary[]>('GET', '/api/investigations');
  const fresh = rows.filter((r) => !before.has(r.id));
  if (fresh.length === 0) return null;
  // More than one only happens if something else is using this instance, which
  // the question match then resolves. If it does not, the run is ambiguous and
  // the newest row is the wrong guess to make silently — so prefer the match.
  const matched = fresh.find((r) => r.intent === question);
  return (matched ?? fresh[fresh.length - 1])!.id;
}

export interface FinishedRun { status: string; report: unknown | null }

/**
 * Wait for the investigation to stop moving, then fetch whatever it saved.
 *
 * Running out of budget is not treated as a harness failure. A product that
 * cannot finish inside a generous budget has failed to answer, and that
 * belongs in the denominator like any other non-answer.
 */
export async function awaitReport(id: string, budgetMs: number): Promise<FinishedRun> {
  const deadline = Date.now() + budgetMs;
  let status = 'unknown';
  while (Date.now() < deadline) {
    const inv = await api<{ status: string }>('GET', `/api/investigations/${id}`);
    status = inv.status;
    if (status === 'completed' || status === 'failed') break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  try {
    return { status, report: await api<unknown>('GET', `/api/investigations/${id}/report`) };
  } catch (err) {
    if (err instanceof ApiUnreachable) throw err;
    return { status, report: null };
  }
}
