/**
 * KubectlExecutionAdapter — `ExecutionAdapter` impl that shells out to the
 * `kubectl` binary. Separates "what to run" (the argv) from "how it's run"
 * (the spawn machinery), so tests can inject a fake `spawn` and assert on
 * argv without touching the network.
 *
 * Phase 6 of `docs/design/auto-remediation.md`.
 *
 * Security:
 *   - The kubeconfig is resolved from the connector's secretRef one execution
 *     at a time, written to an mktemp file with mode 0600, exported as
 *     `KUBECONFIG`, and unlinked in `finally` (also on throw). Never logged,
 *     never persisted.
 *   - Argv is never run through a shell. We `spawn('kubectl', argv)` directly
 *     so shell metacharacters in arguments cannot expand.
 *   - Allowlist + permanent-deny gates run before any spawn; failures throw
 *     before kubectl is reached.
 *
 * Wiring this into the agent's `OpsCommandRunner` is intentionally NOT in
 * this file — that's a later piece (T6.9). This module is library-shaped:
 * inject what it needs, get a working adapter back.
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
import { checkKubectl, type KubectlMode } from './kubectl-allowlist.js';

/** Maximum bytes of stdout/stderr we keep. Tail beyond this is dropped. */
const STDIO_CAP_BYTES = 64 * 1024;

export interface KubectlSpawnFn {
  (
    cmd: string,
    args: readonly string[],
    options?: SpawnOptions,
  ): ChildProcessWithoutNullStreams;
}

export interface KubectlExecutionAdapterOptions {
  /**
   * Bound to the connector this adapter speaks to. The kubeconfig contents
   * are resolved on each `dryRun`/`execute` call (so rotated secrets take
   * effect without restarting the process).
   */
  resolveKubeconfig: () => Promise<string> | string;
  /** From `OpsConnector.allowedNamespaces`. Empty array = no namespace gate. */
  allowedNamespaces: readonly string[];
  /**
   * The call site this adapter speaks for. `'read'` rejects writes, `'write'`
   * accepts both reads and writes (as one expects during plan execution).
   */
  mode: KubectlMode;
  /** Path or name of the kubectl binary. Defaults to `'kubectl'` on $PATH. */
  kubectlBinary?: string;
  /** Override for tests. Defaults to `child_process.spawn`. */
  spawnFn?: KubectlSpawnFn;
  /** Hard timeout for one kubectl invocation, ms. Defaults to 60_000. */
  timeoutMs?: number;
  /**
   * Optional defense-in-depth pre-flight gate. When wired, the adapter
   * calls `preGuard(argv)` before spawning kubectl. A non-null return
   * value REJECTS the action — used to enforce that every write went
   * through ActionGuard upstream. The adapter-local allowlist remains
   * authoritative regardless of this hook.
   */
  preGuard?: (argv: readonly string[]) => Promise<string | null> | string | null;
}

/**
 * The shape we expect under `AdapterAction.params` for kubernetes execution.
 *
 *   argv: the kubectl argv WITHOUT the leading `kubectl` token. The adapter
 *         spawns `kubectl <argv...>`.
 *
 * Other fields on `AdapterAction` (type, targetService, credentialRef,
 * resolvedCredential) are ignored by this adapter — kubeconfig is resolved
 * via `options.resolveKubeconfig`, not via `resolvedCredential`, because
 * the kubeconfig is connector-bound, not action-bound.
 */
interface KubectlActionParams {
  argv: readonly string[];
}

function takeArgv(action: AdapterAction): readonly string[] {
  const params = action.params as unknown as KubectlActionParams | undefined;
  const argv = params?.argv;
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string')) {
    throw new Error('KubectlExecutionAdapter: action.params.argv must be string[]');
  }
  return argv;
}

function tail(buf: Buffer[], cap: number): string {
  const all = Buffer.concat(buf);
  return all.length <= cap ? all.toString('utf8') : all.subarray(all.length - cap).toString('utf8');
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export class KubectlExecutionAdapter implements ExecutionAdapter {
  private readonly opts: Required<Omit<KubectlExecutionAdapterOptions, 'spawnFn' | 'preGuard'>> & {
    spawnFn: KubectlSpawnFn;
    preGuard?: KubectlExecutionAdapterOptions['preGuard'];
  };

  constructor(opts: KubectlExecutionAdapterOptions) {
    this.opts = {
      resolveKubeconfig: opts.resolveKubeconfig,
      allowedNamespaces: opts.allowedNamespaces,
      mode: opts.mode,
      kubectlBinary: opts.kubectlBinary ?? 'kubectl',
      spawnFn: opts.spawnFn ?? (spawn as unknown as KubectlSpawnFn),
      timeoutMs: opts.timeoutMs ?? 60_000,
      ...(opts.preGuard ? { preGuard: opts.preGuard } : {}),
    };
  }

  capabilities(): AdapterCapability[] {
    const readCapabilities: AdapterCapability[] = [
      'runtime.get',
      'runtime.list',
      'runtime.logs',
      'runtime.events',
    ];
    return this.opts.mode === 'read'
      ? readCapabilities
      : [
          ...readCapabilities,
          'runtime.restart',
          'runtime.scale',
          'runtime.rollout',
          'runtime.delete',
        ];
  }

  async validate(action: AdapterAction): Promise<ValidationResult> {
    let argv: readonly string[];
    try {
      argv = takeArgv(action);
    } catch (err) {
      return { valid: false, reason: (err as Error).message };
    }
    const decision = checkKubectl(argv, this.opts.mode, this.opts.allowedNamespaces);
    return decision.allow ? { valid: true } : { valid: false, reason: decision.reason };
  }

  async dryRun(action: AdapterAction): Promise<DryRunResult> {
    const v = await this.validate(action);
    if (!v.valid) {
      throw new Error(`kubectl dry-run rejected: ${v.reason}`);
    }
    const argv = [...takeArgv(action), '--dry-run=server', '-o', 'yaml'];
    const r = await this.run(argv);
    if (r.exitCode !== 0) {
      // Surface the kubectl error verbatim — this is exactly what the operator
      // would see if they ran it themselves. No silent swallowing.
      throw new Error(`kubectl --dry-run=server exited ${r.exitCode}: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return {
      estimatedImpact: r.stdout,
      warnings: r.stderr ? [r.stderr.trim()] : [],
      willAffect: [],
    };
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
    const argv = takeArgv(action);
    if (this.opts.preGuard) {
      const reason = await this.opts.preGuard(argv);
      if (reason !== null && reason !== undefined) {
        return {
          success: false,
          output: '',
          rollbackable: false,
          executionId: randomUUID(),
          error: `pre-guard rejected: ${reason}`,
        };
      }
    }
    const r = await this.run(argv);
    return {
      success: r.exitCode === 0 && !r.timedOut,
      output: r.stdout,
      rollbackable: false,
      executionId: randomUUID(),
      error: r.exitCode !== 0 || r.timedOut
        ? (r.timedOut ? `kubectl timed out after ${this.opts.timeoutMs}ms` : `kubectl exited ${r.exitCode}: ${r.stderr.trim() || r.stdout.trim()}`)
        : undefined,
    };
  }

  /**
   * Spawn `kubectl <argv...>` with a per-invocation kubeconfig file, captured
   * stdout/stderr (capped at STDIO_CAP_BYTES per stream), and an enforced
   * timeout. The kubeconfig file is unlinked in `finally`.
   */
  private async run(argv: readonly string[]): Promise<RunResult> {
    const kubeconfig = await this.opts.resolveKubeconfig();
    const dir = mkdtempSync(join(tmpdir(), 'openobs-kubeconfig-'));
    const kubeconfigPath = join(dir, 'kubeconfig');
    try {
      writeFileSync(kubeconfigPath, kubeconfig, { mode: 0o600 });
      return await new Promise<RunResult>((resolve, reject) => {
        const child = this.opts.spawnFn(this.opts.kubectlBinary, argv as string[], {
          env: {
            // Inherit just enough — we don't want to leak whatever else is in
            // the api-gateway's process env into the kubectl child.
            PATH: process.env['PATH'] ?? '/usr/bin:/usr/local/bin',
            KUBECONFIG: kubeconfigPath,
            HOME: process.env['HOME'] ?? dir,
          },
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
        child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

        let timedOut = false;
        const t = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, this.opts.timeoutMs);

        child.on('error', (err) => {
          clearTimeout(t);
          reject(err);
        });
        child.on('close', (code, signal) => {
          clearTimeout(t);
          resolve({
            stdout: tail(stdoutChunks, STDIO_CAP_BYTES),
            stderr: tail(stderrChunks, STDIO_CAP_BYTES),
            exitCode: code ?? -1,
            signal: signal ?? null,
            timedOut,
          });
        });
      });
    } finally {
      // Best-effort cleanup. Even on throw, the kubeconfig file is gone.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* deliberately ignored — cleanup must not mask the original error */
      }
    }
  }
}
