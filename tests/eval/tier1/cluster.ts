/**
 * Talking to the cluster the scenarios break.
 *
 * Prometheus is reached by exec'ing into its own pod rather than by holding a
 * port-forward open. A port-forward is a child process with a lifetime, and a
 * nightly job that leaks one — or loses one mid-run — turns a real answer into
 * an unexplained INVALID. `kubectl exec` has no lifetime to manage and fails
 * loudly.
 *
 * Every scenario queries through here so that "is the fault visible?" means
 * the same thing everywhere. A scenario that invents its own probe is a
 * scenario whose INVALID rate is not comparable to the others'.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const PROM_NS = process.env['ROUNDS_EVAL_PROM_NS'] ?? 'monitoring';
const PROM_DEPLOY = process.env['ROUNDS_EVAL_PROM_DEPLOY'] ?? 'deploy/prometheus';

export async function kubectl(...args: string[]): Promise<string> {
  const { stdout } = await exec('kubectl', args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

interface PromVector {
  status: string;
  data?: { result?: Array<{ metric: Record<string, string>; value: [number, string] }> };
}

/**
 * One instant query. Returns the samples, which may legitimately be empty —
 * callers decide whether empty means healthy or means the probe is wrong, and
 * that decision is scenario-specific.
 */
export async function promQuery(query: string): Promise<Array<{ labels: Record<string, string>; value: number }>> {
  const url = `http://localhost:9090/api/v1/query?query=${encodeURIComponent(query)}`;
  const raw = await kubectl('exec', '-n', PROM_NS, PROM_DEPLOY, '--', 'wget', '-qO-', url);
  const body = JSON.parse(raw) as PromVector;
  if (body.status !== 'success') throw new Error(`prometheus rejected: ${query}`);
  return (body.data?.result ?? []).map((r) => ({ labels: r.metric, value: Number(r.value[1]) }));
}

/**
 * The single scalar a query returns, or null when it returned nothing.
 *
 * Two series is an error rather than a choice. A confirm step that silently
 * takes the first of several is a confirm step that will one day report on the
 * wrong workload and call the fault observable when it is not — and the run it
 * spoils looks like an ordinary result.
 */
export async function promScalar(query: string): Promise<number | null> {
  const rows = await promQuery(query);
  if (rows.length === 0) return null;
  if (rows.length > 1) throw new Error(`query matched ${rows.length} series, expected 1: ${query}`);
  return rows[0]!.value;
}

/**
 * Poll until a condition on a query holds.
 *
 * Scenarios use this instead of sleeping, because the honest soak time is "as
 * long as it takes for the scrape to land", and that varies with cluster load.
 * A fixed sleep either wastes minutes every run or produces INVALIDs on a busy
 * node — and the second one silently shrinks the denominator.
 */
export async function promUntil(
  query: string,
  holds: (value: number | null) => boolean,
  { timeoutMs = 180_000, intervalMs = 5_000 } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (holds(await promScalar(query))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Run kubectl with a manifest on stdin, so scenarios keep their fault next to their prose. */
function kubectlStdin(args: string[], yaml: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`kubectl ${args.join(' ')} exited ${code}: ${stderr.trim()}`)));
    child.stdin.end(yaml);
  });
}

export const applyManifest = (yaml: string): Promise<void> => kubectlStdin(['apply', '-f', '-'], yaml);

/**
 * `--ignore-not-found` so revert is idempotent: a scenario that failed halfway
 * through inject must still be safe to revert.
 */
export const deleteManifest = (yaml: string): Promise<void> =>
  kubectlStdin(['delete', '-f', '-', '--ignore-not-found'], yaml);
