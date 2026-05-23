/**
 * ShellExecutionAdapter — runs an opaque shell command via `sh -c <command>`
 * with a per-invocation kubeconfig file exposed as KUBECONFIG.
 *
 * Why this exists alongside KubectlExecutionAdapter:
 *   - KubectlExecutionAdapter takes argv and spawns kubectl directly. It
 *     gives per-verb policy gating and rejects shell metacharacters by
 *     construction, which is what remediation plans need.
 *   - The interactive chat path (`ops_run_command`) needs the opposite:
 *     real shell semantics so the model can pipe (`kubectl get pods | grep
 *     istio`), chain (`kubectl ... && kubectl ...`), substitute (`$(...)`)
 *     and use `--tail=20` / heredocs / `jq` without the runner second-
 *     guessing it. Tool-level confirmation handles risk, not argv parsing.
 *
 * Security model:
 *   - The kubeconfig is materialized to an mktemp file with mode 0600,
 *     exported via KUBECONFIG, and unlinked in `finally` (also on throw).
 *   - The shell inherits a deliberately narrow env (PATH, KUBECONFIG, HOME).
 *     The api-gateway's other env vars are NOT propagated.
 *   - Risk gating and user confirmation are upstream concerns (runner +
 *     UI). This adapter is intentionally permissive: caller already decided
 *     it's safe to execute.
 */

import { spawn, type SpawnOptions, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AdapterAction,
  AdapterCapability,
  DryRunResult,
  ExecutionAdapter,
  ExecutionResult,
  ValidationResult,
} from './types.js';

const STDIO_CAP_BYTES = 256 * 1024;

export interface ShellSpawnFn {
  (
    cmd: string,
    args: readonly string[],
    options?: SpawnOptions,
  ): ChildProcessWithoutNullStreams;
}

export interface ShellExecutionAdapterOptions {
  resolveKubeconfig: () => Promise<string> | string;
  /** Override for tests. Defaults to `child_process.spawn`. */
  spawnFn?: ShellSpawnFn;
  /** Hard timeout for one shell invocation, ms. Defaults to 120_000. */
  timeoutMs?: number;
  /** Path or name of the shell binary. Defaults to `/bin/sh`. */
  shellBinary?: string;
}

interface ShellActionParams {
  /** The full command string. Run as `sh -c "<command>"`. */
  command: string;
}

function takeCommand(action: AdapterAction): string {
  const params = action.params as unknown as ShellActionParams | undefined;
  const cmd = params?.command;
  if (typeof cmd !== 'string' || !cmd.trim()) {
    throw new Error('ShellExecutionAdapter: action.params.command must be a non-empty string');
  }
  return cmd;
}

function tail(buf: Buffer[], cap: number): string {
  const all = Buffer.concat(buf);
  return all.length <= cap ? all.toString('utf8') : all.subarray(all.length - cap).toString('utf8');
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/**
 * Render shell output for the model: stdout first (the data), then a small
 * metadata footer with stderr and exit code when relevant. Exit 0 with no
 * stderr is the common case and rendered as bare stdout so the model
 * doesn't get noise. Anything else gets the footer so the model has the
 * full picture to reason about.
 */
function formatShellObservation(r: RunResult): string {
  const stderr = r.stderr.trim();
  const stdout = r.stdout;
  if (r.exitCode === 0 && !stderr && !r.timedOut) return stdout;
  const parts: string[] = [];
  if (stdout) parts.push(stdout);
  const footer: string[] = [];
  if (stderr) footer.push(`stderr: ${stderr}`);
  if (r.exitCode !== 0) footer.push(`exit: ${r.exitCode}`);
  if (r.timedOut) footer.push('timed out');
  if (footer.length) parts.push(`[${footer.join(' | ')}]`);
  return parts.join('\n');
}

export class ShellExecutionAdapter implements ExecutionAdapter {
  private readonly opts: Required<Omit<ShellExecutionAdapterOptions, 'spawnFn'>> & {
    spawnFn: ShellSpawnFn;
  };

  constructor(opts: ShellExecutionAdapterOptions) {
    this.opts = {
      resolveKubeconfig: opts.resolveKubeconfig,
      spawnFn: opts.spawnFn ?? (spawn as unknown as ShellSpawnFn),
      timeoutMs: opts.timeoutMs ?? 120_000,
      shellBinary: opts.shellBinary ?? '/bin/sh',
    };
  }

  capabilities(): AdapterCapability[] {
    // Opaque-shell adapter doesn't pre-declare verbs. Capability gating is
    // performed by the upstream runner (pattern-based risk + confirmation).
    return [];
  }

  async validate(action: AdapterAction): Promise<ValidationResult> {
    try {
      takeCommand(action);
      return { valid: true };
    } catch (err) {
      return { valid: false, reason: (err as Error).message };
    }
  }

  async dryRun(_action: AdapterAction): Promise<DryRunResult> {
    // Arbitrary shell can't be dry-run generically.
    return { estimatedImpact: '(opaque shell — no dry-run)', warnings: [], willAffect: [] };
  }

  async execute(action: AdapterAction): Promise<ExecutionResult> {
    const v = await this.validate(action);
    if (!v.valid) {
      return {
        success: false,
        output: '',
        rollbackable: false,
        executionId: randomUUID(),
        error: v.reason,
      };
    }
    const command = takeCommand(action);
    const r = await this.run(command);
    // Bash-tool semantics (à la Claude Code): there is no success/failure
    // distinction for shell. The shell ran, here's what it printed and
    // how it ended — the model reads stdout/stderr/exit and decides. Exit
    // non-zero is normal for chains (`a && b`), fallbacks (`a || b`),
    // greps with no match, `kubectl get` on a missing resource, etc.
    // Forcing a binary success flag here just causes the model to retry
    // things that actually returned the data it wanted.
    //
    // Timeouts are surfaced the same way — as a line in the observation —
    // because "kubectl wait on a slow rollout timed out" is sometimes
    // exactly the answer the model is after.
    return {
      success: true,
      output: formatShellObservation(r),
      rollbackable: false,
      executionId: randomUUID(),
    };
  }

  private async run(command: string): Promise<RunResult> {
    const kubeconfig = await this.opts.resolveKubeconfig();
    const dir = mkdtempSync(join(tmpdir(), 'rounds-kubeconfig-'));
    const kubeconfigPath = join(dir, 'kubeconfig');
    try {
      writeFileSync(kubeconfigPath, kubeconfig, { mode: 0o600 });
      return await new Promise<RunResult>((resolve, reject) => {
        // `detached: true` makes the shell its own process-group leader,
        // so the backgrounded children it spawns (`kubectl port-forward
        // ... &`, `nohup …`, etc.) inherit the same PGID. When the shell
        // exits we send a signal to the negative PID, which Unix
        // interprets as "the whole process group" — that's how we stop
        // background descendants from outliving the tool call.
        const child = this.opts.spawnFn(this.opts.shellBinary, ['-c', command], {
          env: {
            PATH: process.env['PATH'] ?? '/usr/bin:/usr/local/bin:/bin',
            KUBECONFIG: kubeconfigPath,
            HOME: process.env['HOME'] ?? dir,
          },
          detached: true,
        });
        const pgid = child.pid;

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
        child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
        // Swallow EPIPE/ECONNRESET when we destroy pipes after exit so a
        // backgrounded grandchild's late write doesn't surface as an
        // unhandled error.
        child.stdout.on('error', () => { /* ignored */ });
        child.stderr.on('error', () => { /* ignored */ });

        let timedOut = false;
        let settled = false;
        const settle = (result: RunResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          // Kill any background descendants of the shell so port-forwards,
          // tails, sleeps etc. don't outlive the tool call. Negative PID
          // targets the whole process group; SIGTERM first, then a hard
          // SIGKILL after a short grace period for stragglers.
          if (pgid) {
            try { process.kill(-pgid, 'SIGTERM'); } catch { /* group already gone */ }
            setTimeout(() => {
              try { process.kill(-pgid, 'SIGKILL'); } catch { /* expected once dead */ }
            }, 200).unref();
          }
          resolve(result);
        };

        const t = setTimeout(() => {
          timedOut = true;
          if (pgid) {
            try { process.kill(-pgid, 'SIGKILL'); } catch { /* fine */ }
          }
        }, this.opts.timeoutMs);

        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          reject(err);
        });
        // Use `exit` (process termination) rather than `close` (all stdio
        // streams closed) — backgrounded children inherit the parent's
        // stdout/stderr FDs, which keeps the close event waiting forever
        // even after the foreground shell command finished.
        child.on('exit', (code) => {
          settle({
            stdout: tail(stdoutChunks, STDIO_CAP_BYTES),
            stderr: tail(stderrChunks, STDIO_CAP_BYTES),
            exitCode: code ?? -1,
            timedOut,
          });
        });
      });
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* deliberately ignored — cleanup must not mask the original error */
      }
    }
  }
}
